/********************************************************************************
 * Copyright (c) 2022 STMicroelectronics.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * https://www.eclipse.org/legal/epl-2.0, or the MIT License which is
 * available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: EPL-2.0 OR MIT
 *******************************************************************************/
import {
    AnyObject,
    Diagnostic,
    Format,
    MessageDataMapper,
    MessageType,
    Model,
    ModelServerClientV2,
    ModelServerCommand,
    ModelServerCommandPackage,
    ModelServerMessage,
    ModelServerNotification,
    ModelServerObject,
    ModelUpdateResult,
    ServerConfiguration,
    SubscriptionListener,
    SubscriptionOptions,
    TypeGuard
} from '@eclipse-emfcloud/modelserver-client';
import { EditTransaction, Executor, Logger, ModelServerClientApi, Transaction } from '@eclipse-emfcloud/modelserver-plugin-ext';
import axios from 'axios';
import { Operation } from 'fast-json-patch';
import { inject, injectable, named } from 'inversify';
import * as URI from 'urijs';
import { v4 as uuid } from 'uuid';
import * as WebSocket from 'ws';

import { CommandProviderRegistry } from '../command-provider-registry';
import { TriggerProviderRegistry } from '../trigger-provider-registry';
import { CompletablePromise } from './promise-utils';
import { WebSocketMessageAcceptor } from './web-socket-utils';

export const UpstreamConnectionConfig = Symbol('UpstreamConnectionConfig');

/**
 * Configuration of the connection to the _Upstream Model Server_.
 */
export interface UpstreamConnectionConfig {
    hostname: string;
    serverPort: number;
    baseURL: string;
}

export const InternalModelServerClientApi = Symbol('InternalModelServerClientApi');

/**
 * Private client API for the new endpoints in the _Model Server_ v2 API that are internal to
 * the _Model Server_.
 */
export interface InternalModelServerClientApi extends ModelServerClientApi {
    /**
     * Initialize me to communicate with the _Upstream Model Server_.
     */
    initialize(): void | Promise<void>;

    /**
     * Open a transactional self-compounding command/patch execution context on a model.
     *
     * @param modeluri the URI of the model on which to open the transaction
     * @returns a transactional context in which to execute a chained sequence of commands,
     *     or a rejected promise in the case that a transaction is already open on the given model
     */
    openTransaction(modeluri: URI): Promise<TransactionContext>;
}

/**
 * Protocol for the client-side context of an open transaction on a model URI.
 */
export interface TransactionContext extends Executor, EditTransaction {
    /**
     * Open a nested (child) transaction.
     * It commits its changes into the parent transaction that opened it.
     * It rolls back all changes up the transaction stack, closing the root transaction.
     */
    openTransaction(): Promise<TransactionContext>;
}

/**
 * Protocol of messages sent to and received from the _Model Server_ on a transaction socket.
 */
export interface ModelServerTransactionMessage<T = unknown> extends ModelServerMessage<T>, ModelServerNotification {
    type: 'execute' | 'close' | 'roll-back' | 'incrementalUpdate' | 'success';
}

export type MessageBody = ModelServerTransactionMessage;

/**
 * Definition of the response body for the `POST` request on the `transaction` endpoint.
 */
interface CreateTransactionResponseBody {
    data: {
        /**
         * The URI of the new transaction. This is the URI to connect a websocket to for messaging
         * command execution and receipt of private incremental updates.
         */
        uri: string;
    };
}

/** Use the v2 JSON format by default. */
const DEFAULT_FORMAT = 'json-v2';

/**
 * The kind of message payload for the `execute` message type.
 */
export type ExecuteMessageBody = ExecuteCommand | ExecutePatch;

/** A command payload. */
export interface ExecuteCommand {
    type: 'modelserver.emfcommand';
    data: ModelServerCommand;
}

/** A JSON Patch payload. */
export interface ExecutePatch {
    type: 'modelserver.patch';
    data: Operation | Operation[];
}

export namespace ExecuteMessageBody {
    /** Is an `object` an `ExecuteCommand`? */
    export function isCommand(object: any): object is ExecuteCommand {
        return 'type' in object && object.type === 'modelserver.emfcommand';
    }

    /** Is an `object` an `ExecutePatch`? */
    export function isPatch(object: any): object is ExecutePatch {
        return 'type' in object && object.type === 'modelserver.patch';
    }
}

/**
 * Default implementation of the version 2 client API for the _Model Server_ (a.k.a. _Upstream Model Server_).
 */
@injectable()
export class InternalModelServerClient implements InternalModelServerClientApi {
    @inject(Logger)
    @named(InternalModelServerClient.name)
    protected readonly logger: Logger;

    @inject(CommandProviderRegistry)
    protected readonly commandProviderRegistry: CommandProviderRegistry;

    @inject(TriggerProviderRegistry)
    protected readonly triggerProviderRegistry: TriggerProviderRegistry;

    @inject(UpstreamConnectionConfig)
    protected readonly upstreamConnectionConfig: UpstreamConnectionConfig;

    protected readonly transactions: Map<string, TransactionContext> = new Map();

    protected readonly delegate: ModelServerClientApi = new ModelServerClientV2();

    protected _baseURL: URI;

    initialize(): void | Promise<void> {
        this._baseURL = new URI({
            protocol: 'http',
            hostname: this.upstreamConnectionConfig.hostname,
            port: this.upstreamConnectionConfig.serverPort,
            path: this.upstreamConnectionConfig.baseURL
        });
        return this.delegate.initialize(this._baseURL, DEFAULT_FORMAT);
    }

    async openTransaction(modelUri: URI): Promise<TransactionContext> {
        const uriKey = modelUri.normalize().toString();
        if (this.transactions.has(uriKey)) {
            // Open a nested transaction
            return this.transactions.get(uriKey).openTransaction();
        }

        const clientID = uuid();

        return axios.post(this.makeURL('transaction', modelUri), { data: clientID }).then(response => {
            const { uri: transactionURI } = (response.data as CreateTransactionResponseBody).data;
            const result = new DefaultTransactionContext(
                transactionURI,
                modelUri,
                this.commandProviderRegistry,
                this.triggerProviderRegistry,
                this.logger
            );
            this.transactions.set(uriKey, result);
            return result.open(tc => this.closeTransaction(modelUri, tc));
        });
    }

    private closeTransaction(modeluri: URI, tc: TransactionContext): void {
        if (this.transactions.get(modeluri.toString()) === tc) {
            this.transactions.delete(modeluri.toString());
        }
    }

    protected makeURL(path: string, modeluri: URI): string {
        const uri = this._baseURL.clone();
        path.split('/').forEach(seg => uri.segment(seg));
        uri.addQuery('modeluri', modeluri);
        return uri.toString();
    }

    //
    // API Delegation
    //

    getAll(): Promise<Model<unknown>[]>;
    getAll<M>(typeGuard: TypeGuard<M>): Promise<Model<M>[]>;
    getAll(format: Format): Promise<Model<string>[]>;
    getAll<M>(format?: Format | TypeGuard<M>): Promise<Model<unknown>[] | Model<M>[] | string[]> {
        if (typeof format === 'string') {
            return this.delegate.getAll(format);
        }
        return this.delegate.getAll(format);
    }
    get(modeluri: URI, format?: Format): Promise<AnyObject>;
    get<M>(modeluri: URI, typeGuard: TypeGuard<M>, format?: Format): Promise<M>;
    get<M>(modeluri: URI, typeGuard?: Format | TypeGuard<M>, format?: Format): Promise<AnyObject | M> {
        if (!typeGuard) {
            return this.delegate.get(modeluri, format);
        }
        if (typeof typeGuard === 'string') {
            return this.delegate.get(modeluri, typeGuard);
        }
        return this.delegate.get(modeluri, typeGuard);
    }
    getModelUris(): Promise<URI[]> {
        return this.delegate.getModelUris();
    }
    getElementById(modeluri: URI, elementid: string, format?: Format): Promise<AnyObject>;
    getElementById<M>(modeluri: URI, elementid: string, typeGuard: TypeGuard<M>): Promise<M>;
    getElementById<M>(modeluri: URI, elementid: string, typeGuard?: Format | TypeGuard<M>, format?: Format): Promise<AnyObject | M> {
        if (!typeGuard) {
            return this.delegate.getElementById(modeluri, elementid, format);
        }
        if (typeof typeGuard === 'string') {
            return this.delegate.getElementById(modeluri, elementid, typeGuard);
        }
        return this.delegate.getElementById(modeluri, elementid, typeGuard, format);
    }
    getElementByName(modeluri: URI, elementname: string, format?: Format): Promise<AnyObject>;
    getElementByName<M>(modeluri: URI, elementname: string, typeGuard: TypeGuard<M>): Promise<M>;
    getElementByName<M>(modeluri: URI, elementname: string, typeGuard?: Format | TypeGuard<M>, format?: Format): Promise<AnyObject | M> {
        if (!typeGuard) {
            return this.delegate.getElementByName(modeluri, elementname, format);
        }
        if (typeof typeGuard === 'string') {
            return this.delegate.getElementByName(modeluri, elementname, typeGuard);
        }
        return this.delegate.getElementByName(modeluri, elementname, typeGuard, format);
    }
    delete(modeluri: URI): Promise<boolean> {
        return this.delegate.delete(modeluri);
    }
    close(modeluri: URI): Promise<boolean> {
        return this.delegate.close(modeluri);
    }
    create(modeluri: URI, model: string | AnyObject, format?: Format): Promise<AnyObject>;
    create<M>(modeluri: URI, model: string | AnyObject, typeGuard: TypeGuard<M>, format?: Format): Promise<M>;
    create<M>(modeluri: URI, model: string, typeGuard?: Format | TypeGuard<M>, format?: Format): Promise<AnyObject | M> {
        if (!typeGuard) {
            return this.delegate.create(modeluri, model, format);
        }
        if (typeof typeGuard === 'string') {
            return this.delegate.create(modeluri, model, typeGuard);
        }
        return this.delegate.create(modeluri, model, typeGuard, format);
    }
    update(modeluri: URI, model: AnyObject | string, format?: Format): Promise<AnyObject>;
    update<M>(modeluri: URI, model: AnyObject | string, typeGuard: TypeGuard<M>, format?: Format): Promise<M>;
    update<M>(modeluri: URI, model: AnyObject | string, typeGuard?: Format | TypeGuard<M>, format?: Format): Promise<AnyObject | M> {
        if (!typeGuard) {
            return this.delegate.update(modeluri, model, format);
        }
        if (typeof typeGuard === 'string') {
            return this.delegate.update(modeluri, model, typeGuard);
        }
        return this.delegate.update(modeluri, model, typeGuard, format);
    }
    save(modeluri: URI): Promise<boolean> {
        return this.delegate.save(modeluri);
    }
    saveAll(): Promise<boolean> {
        return this.delegate.saveAll();
    }
    validate(modeluri: URI): Promise<Diagnostic> {
        return this.delegate.validate(modeluri);
    }
    getValidationConstraints(modeluri: URI): Promise<string> {
        return this.delegate.getValidationConstraints(modeluri);
    }
    getTypeSchema(modeluri: URI): Promise<string> {
        return this.delegate.getTypeSchema(modeluri);
    }
    getUiSchema(schemaname: string): Promise<string> {
        return this.delegate.getUiSchema(schemaname);
    }
    configureServer(configuration: ServerConfiguration): Promise<boolean> {
        return this.delegate.configureServer(configuration);
    }
    ping(): Promise<boolean> {
        return this.delegate.ping();
    }
    edit(modeluri: URI, patch: Operation | Operation[], format?: Format): Promise<ModelUpdateResult>;
    edit(modeluri: URI, command: ModelServerCommand, format?: Format): Promise<ModelUpdateResult>;
    edit(modeluri: URI, patchOrCommand: Operation | Operation[] | ModelServerCommand): Promise<ModelUpdateResult> {
        if (patchOrCommand instanceof ModelServerCommand) {
            return this.delegate.edit(modeluri, patchOrCommand);
        }
        if (Array.isArray(patchOrCommand)) {
            return this.delegate.edit(modeluri, patchOrCommand);
        }
        return this.delegate.edit(modeluri, patchOrCommand);
    }
    undo(modeluri: URI): Promise<ModelUpdateResult> {
        return this.delegate.undo(modeluri);
    }
    redo(modeluri: URI): Promise<ModelUpdateResult> {
        return this.delegate.redo(modeluri);
    }
    subscribe(modeluri: URI, listener: SubscriptionListener, options?: SubscriptionOptions): SubscriptionListener {
        return this.delegate.subscribe(modeluri, listener, options);
    }
    send(modeluri: URI, message: ModelServerMessage<unknown>): void {
        return this.delegate.send(modeluri, message);
    }
    unsubscribe(modeluri: URI): void {
        return this.delegate.unsubscribe(modeluri);
    }
}

/**
 * A context tracking the state of transactions while nested transactions are in progress.
 * Edit transactions for custom commands and triggers can be recursive: custom command transactions can execute
 * other custom commands and trigger patches can trigger further updates.
 * The `NestedEditContext` tracks the state of a parent transaction while a child transaction is in progress
 * so that when the child completes, its state can be appended to the parent state.
 * If a child transaction fails, its state is discarded.
 */
interface NestedEditContext {
    /** The aggregate of edits reported so far on the model by the upstream _Model Server_. */
    aggregatedUpdateResult: ModelUpdateResult;
}

/**
 * Default implementation of the client-side transaction context with socket message handling.
 */
class DefaultTransactionContext implements TransactionContext {
    private socket: WebSocket;

    private nestedContexts: NestedEditContext[] = [];

    private readonly uuid: CompletablePromise<string>;

    constructor(
        protected readonly transactionURI: string,
        protected readonly modelURI: URI,
        protected readonly commandProviderRegistry: CommandProviderRegistry,
        protected readonly triggerProviderRegistry: TriggerProviderRegistry,
        protected readonly logger: Logger
    ) {
        // Ensure that asynchronous functions don't lose their 'this' context
        this.open = this.open.bind(this);
        this.execute = this.execute.bind(this);
        this.commit = this.commit.bind(this);
        this.rollback = this.rollback.bind(this);

        this.uuid = CompletablePromise.newPromise();
    }

    // Doc inherited from `EditTransaction` interface
    getModelURI(): URI {
        return this.modelURI;
    }

    // Doc inherited from `EditTransaction` interface
    isOpen(): boolean {
        return !!this.socket && this.socket.readyState === WebSocket.OPEN;
    }

    /**
     * Open a new transaction on the upstream _Model Server_.
     *
     * @param closeCallback a call-back to invoke when the transaction is closed, for example to clean up associated bookkeeping
     * @returns a new transaction context
     */
    open(closeCallback: (tc: TransactionContext) => void): Promise<TransactionContext> {
        const result: Promise<TransactionContext> = new Promise((resolveTransaction, reject) => {
            const wsURI = new URL(this.transactionURI);
            wsURI.protocol = 'ws';
            const socket = new WebSocket(wsURI.toString());

            socket.onclose = event => {
                closeCallback?.(this);
                this.socket = undefined;
            };
            socket.onopen = event => {
                this.socket = socket;
                WebSocketMessageAcceptor.promise<string, string>(
                    this.socket,
                    msg => typeof msg.data === 'string',
                    MessageDataMapper.asString
                )
                    .then(uuid_ => {
                        this.uuid.resolve(uuid_);
                        resolveTransaction(this);
                    })
                    .catch(this.uuid.reject);
            };
            socket.onmessage = event => {
                this.logger.debug(`Message: ${event.data}`);
            };
            socket.onerror = event => {
                this.logger.error(`Socket error in ${wsURI}:\n`, event.error);
                reject(event.error);
            };

            this.pushNestedContext();
        });

        return result;
    }

    /**
     * Obtain the UUID of this transaction, when it has been received from the upstream server.
     *
     * @returns the UUID, when it is available
     */
    getUUID(): PromiseLike<string> {
        return this.uuid;
    }

    // Doc inherited from `EditTransaction` interface
    edit(patchOrCommand: Operation | Operation[] | ModelServerCommand): Promise<ModelUpdateResult> {
        if (isModelServerCommand(patchOrCommand)) {
            return this.execute(this.getModelURI(), patchOrCommand);
        }
        return this.applyPatch(patchOrCommand);
    }

    // Doc inherited from `Executor` interface
    async applyPatch(patch: Operation | Operation[]): Promise<ModelUpdateResult> {
        if (!this.isOpen()) {
            return Promise.reject('Socket is closed.');
        }

        if (!patch || (Array.isArray(patch) && patch.length === 0)) {
            return { success: false };
        }

        return this.autoRollback(this.sendPatch(patch));
    }

    /**
     * Wrap an edit result to roll back the transaction automatically if the edit
     * fails with an exception.
     *
     * @param editResult the promise to wrap
     * @returns the wrapped edit result promise
     */
    protected autoRollback<T>(editResult: Promise<T>): Promise<T> {
        return editResult.catch(async reason => {
            this.logger.error(`Transaction rolling back due to exception: ${reason}`);
            await this.rollback(reason);
            throw reason;
        });
    }

    private async sendPatch(patch: Operation | Operation[]): Promise<ModelUpdateResult> {
        return this.sendExecuteMessage({
            type: 'modelserver.patch',
            data: patch
        });
    }

    // Doc inherited from `Executor` interface
    async execute(modelUri: URI, command: ModelServerCommand): Promise<ModelUpdateResult> {
        if (!this.isOpen()) {
            return Promise.reject('Socket is closed.');
        }

        return this.autoRollback(this.doExecute(modelUri, command));
    }

    /** Internal implementation of the {@link TransactionContext.execute} method. */
    async doExecute(modelUri: URI, command: ModelServerCommand): Promise<ModelUpdateResult> {
        // Hook in command-provider plug-ins
        if (!this.commandProviderRegistry.hasProvider(command.type)) {
            // Not handled. Send along to the Model Server
            return this.sendCommand(command);
        } else {
            this.logger.debug(`Getting commands provided recursively for ${command.type}`);

            const provided = await this.commandProviderRegistry.getCommands(modelUri, command);
            if (typeof provided === 'function') {
                // It's a transaction function. We already have a transaction context (this one)
                this.pushNestedContext();
                const success = await provided(this);
                if (!success) {
                    this.popNestedContext(); // These changes were rolled back
                    return Promise.reject('Command execution failed.');
                }
                return this.popNestedContext();
            } else {
                // It's a substitute command or patch. Just pass it on in the usual way
                if (isModelServerCommand(provided)) {
                    return this.sendCommand(provided);
                }
                return this.sendPatch(provided);
            }
        }
    }

    private async sendCommand(command: ModelServerCommand): Promise<ModelUpdateResult> {
        return this.sendExecuteMessage({
            type: 'modelserver.emfcommand',
            data: command
        });
    }

    private async sendExecuteMessage(body: ExecuteMessageBody): Promise<ModelUpdateResult> {
        if (!this.isOpen()) {
            return Promise.reject('Socket is closed.');
        }

        // Make sure that we have first processed the transaction opening exchange
        await this.getUUID();

        const { aggregatedUpdateResult: current } = this.peekNestedContext();
        const result = WebSocketMessageAcceptor.promise<any, ModelUpdateResult>(
            this.socket,
            message => true, // Need to accept and merge failed updates as well as successful
            MessageDataMapper.patchModel
        ).then(modelUpdateResult => {
            // If we are currently tracking a merged update result, incorporate this new result
            if (current) {
                this.mergeModelUpdateResult(current, modelUpdateResult);
            }
            return modelUpdateResult;
        });

        this.socket.send(JSON.stringify(this.message('execute', body)));

        return result;
    }

    /**
     * Push a nested execution context to collect execution results from nested command execution.
     *
     * @returns whether this was the (first) topmost nested context being pushed
     */
    private pushNestedContext(): boolean {
        const resultMessage = { type: MessageType.success, data: { patch: [] } };
        const aggregatedUpdateResult: ModelUpdateResult = MessageDataMapper.patchModel(resultMessage);
        return this.nestedContexts.push({ aggregatedUpdateResult }) === 1;
    }

    /**
     * Get the deepest (current) nested execution context on the stack.
     *
     * @returns the current nested execution context
     */
    private peekNestedContext(): NestedEditContext | undefined {
        if (this.nestedContexts.length) {
            return this.nestedContexts[this.nestedContexts.length - 1];
        }
        return undefined;
    }

    /**
     * Pop the deepest (current) nested execution context from the stack.
     * Its changes are aggregated onto the nest context up the stack, if any, to "commit" them into the current transaction.
     *
     * @returns the popped nested execution context
     */
    private popNestedContext(): ModelUpdateResult {
        const { aggregatedUpdateResult: result } = this.nestedContexts.pop();
        const currentContext = this.peekNestedContext();
        if (currentContext) {
            this.mergeModelUpdateResult(currentContext.aggregatedUpdateResult, result);
        }
        return result;
    }

    /**
     * Merge an additional model update result into a destination aggregation results.
     *
     * @param dst the model update result into which to merge an additional result
     * @param src an addition model update result, if any, to merge into the destination
     */
    private mergeModelUpdateResult(dst: ModelUpdateResult, src?: ModelUpdateResult): void {
        if (src?.patch && src.patch.length) {
            dst.success = dst.success && src.success;
            dst.patch = (dst.patch ?? []).concat(src.patch);

            if (dst.success && src.patchModel) {
                dst.patchModel = src.patchModel;
            }
        }
    }

    // Doc inherited from `EditTransaction` interface
    async commit(): Promise<ModelUpdateResult> {
        const updateResult = this.popNestedContext();

        if (!this.isOpen()) {
            return transactionClosed;
        }

        let modelDelta = updateResult.patch;
        while (modelDelta && modelDelta.length) {
            const triggers = await this.autoRollback(this.triggerProviderRegistry.getTriggers(this.modelURI, modelDelta));
            if (!this.hasTriggers(triggers)) {
                // Nothing left to process
                modelDelta = undefined;
            } else {
                const triggerResult = await this.performTriggers(triggers);
                this.mergeModelUpdateResult(updateResult, triggerResult);
                modelDelta = triggerResult.patch;
            }
        }

        this.socket.send(JSON.stringify(this.message('close')));
        return updateResult;
    }

    hasTriggers(triggers: Operation[] | Transaction): boolean {
        return triggers && (typeof triggers === 'function' || triggers.length > 0);
    }

    // Doc inherited from `EditTransaction` interface
    async rollback(error: any): Promise<ModelUpdateResult> {
        if (this.isOpen()) {
            this.socket.send(JSON.stringify(this.message('roll-back', { error })));
        }
        return transactionClosed;
    }

    /**
     * Perform `triggers` to update the model in consequence of changes that have been performed
     * by the transaction context that we are closing.
     *
     * @param triggers the triggers to apply to the model
     * @returns a new model update result describing the changes performed by the `triggers`
     */
    async performTriggers(triggers: Operation[] | Transaction): Promise<ModelUpdateResult> {
        let result: ModelUpdateResult;

        // Start a nested transaction context
        this.pushNestedContext();

        try {
            if (typeof triggers === 'function') {
                await triggers(this);
            } else {
                await this.applyPatch(triggers);
            }
        } finally {
            result = this.popNestedContext();
        }

        return result;
    }

    /**
     * Assemble a message to send to the upstream _Model Server_.
     *
     * @param type the message type
     * @param data the payload of the message
     * @returns the message body
     */
    protected message(type: MessageBody['type'], data: unknown = {}): MessageBody {
        return {
            type,
            modeluri: this.modelURI,
            data
        };
    }

    // Open a child transaction
    openTransaction(): Promise<TransactionContext> {
        // Push a nested context onto the stack for this child transaction
        this.pushNestedContext();

        // Mostly, a child transaction just delegates to the parent, especially to
        // pass edits to the upstream server. The main difference is that a commit
        // just pops the nested context
        const result = {
            getModelURI: this.getModelURI.bind(this),
            isOpen: this.isOpen.bind(this),
            edit: this.edit.bind(this),
            applyPatch: this.applyPatch.bind(this),
            execute: this.execute.bind(this),
            openTransaction: this.openTransaction.bind(this),
            rollback: this.rollback.bind(this),
            // This is the slight wrinkle
            commit: this.popNestedContext.bind(this)
        };

        return Promise.resolve(result);
    }
}

// A model update result indicating that the transaction was already closed or was rolled back
const transactionClosed: ModelUpdateResult = { success: false };

/**
 * Query whether an `object` is any kind of `ModelServerCommand`.
 *
 * @param object an object
 * @returns whether it is a `ModelServerCommand` of some kind
 */
export function isModelServerCommand(object: any): object is ModelServerCommand {
    return ModelServerObject.is(object) && object.eClass.startsWith(ModelServerCommandPackage.NS_URI + '#//');
}
