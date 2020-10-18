/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import {LanguageServiceDefaultsImpl} from './monaco.contribution';
import {JsonnetWorkerImpl} from "./jsonnetWorker";

const STOP_WHEN_IDLE_FOR = 2 * 60 * 1000; // 2min

export class WorkerManager {

    private _defaults: LanguageServiceDefaultsImpl;
    private _idleCheckInterval;
    private _lastUsedTime: number;
    private _configChangeListener: monaco.IDisposable;

    private _worker: monaco.editor.MonacoWebWorker<JsonnetWorkerImpl>;
    private _client: Promise<JsonnetWorkerImpl>;

    constructor(defaults: LanguageServiceDefaultsImpl) {
        this._defaults = defaults;
        this._worker = null;
        this._idleCheckInterval = setInterval(() => this._checkIfIdle(), 30 * 1000);
        this._lastUsedTime = 0;
        this._configChangeListener = this._defaults.onDidChange(() => this._stopWorker());
    }

    private _stopWorker(): void {
        if (this._worker) {
            this._worker.dispose();
            this._worker = null;
        }
        this._client = null;
    }

    dispose(): void {
        clearInterval(this._idleCheckInterval);
        this._configChangeListener.dispose();
        this._stopWorker();
    }

    private _checkIfIdle(): void {
        if (!this._worker) {
            return;
        }
        let timePassedSinceLastUsed = Date.now() - this._lastUsedTime;
        if (timePassedSinceLastUsed > STOP_WHEN_IDLE_FOR) {
            this._stopWorker();
        }
    }

    private _getClient(): Promise<JsonnetWorkerImpl> {
        this._lastUsedTime = Date.now();

        if (!this._client) {
            this._worker = monaco.editor.createWebWorker<JsonnetWorkerImpl>({
                // module that exports the create() method and returns a `JsonnetWorkerImpl` instance
                moduleId: 'vs/language/jsonnet/jsonnetWorker',

                label: this._defaults.languageId,

                // passed in to the create() method
                createData: {
                    languageSettings: this._defaults.diagnosticsOptions,
                    languageId: this._defaults.languageId,
                    enableSchemaRequest: this._defaults.diagnosticsOptions.enableSchemaRequest
                },

                keepIdleModels: true
            });

            this._client = <Promise<JsonnetWorkerImpl>><any>this._worker.getProxy().then((worker) => {
                if (this._worker) {
                    let uris = monaco.editor
                        .getModels()
                        // .filter((model) => model.getModeId() === this._modeId)
                        .map((model) => model.uri);
                    return this._worker.withSyncedResources(uris);
                }
                return worker;
            });
        }

        return this._client;
    }

    getLanguageServiceWorker(...resources: monaco.Uri[]): Promise<JsonnetWorkerImpl> {
        let _client: JsonnetWorkerImpl;
        return this._getClient().then((client) => {
            _client = client
        }).then(_ => {
            return this._worker.withSyncedResources(resources)
        }).then(_ => _client);
    }
}
