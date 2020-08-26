/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import Thenable = monaco.Thenable;
import IWorkerContext = monaco.worker.IWorkerContext;
import IMirrorModel = worker.IMirrorModel;
import Library = monaco.languages.jsonnet.Library;
import JsonnetWorker = monaco.languages.jsonnet.JsonnetWorker;
import ExtCodes = monaco.languages.jsonnet.ExtCodes;
import TlaVars = monaco.languages.jsonnet.TlaVars;
import JsonnetVM, {FileMap, JsonnetError} from './jsonnet';
import * as Json from 'jsonc-parser';

import * as jsonService from 'vscode-json-languageservice';
import {LanguageSettings, SchemaRequestService} from 'vscode-json-languageservice';
import {Uri, worker} from "monaco-editor-core";

let defaultSchemaRequestService;
if (typeof fetch !== 'undefined') {
    defaultSchemaRequestService = function (url) {
        return fetch(url).then(response => response.text())
    };
}

const extensions = ['.jsonnet', '.libsonnet']

class PromiseAdapter<T> implements jsonService.Thenable<T> {
    private wrapped: Promise<T>;

    constructor(executor: (resolve: (value?: T | jsonService.Thenable<T>) => void, reject: (reason?: any) => void) => void) {
        this.wrapped = new Promise<T>(executor);
    }

    public then<TResult>(onfulfilled?: (value: T) => TResult | jsonService.Thenable<TResult>, onrejected?: (reason: any) => void): jsonService.Thenable<TResult> {
        let thenable: jsonService.Thenable<T> = this.wrapped;
        return thenable.then(onfulfilled, onrejected);
    }

    public getWrapped(): monaco.Thenable<T> {
        return this.wrapped;
    }

    public static resolve<T>(v: T | Thenable<T>): jsonService.Thenable<T> {
        return <monaco.Thenable<T>>Promise.resolve(v);
    }

    public static reject<T>(v: T): jsonService.Thenable<T> {
        return Promise.reject(<any>v);
    }

    public static all<T>(values: jsonService.Thenable<T>[]): jsonService.Thenable<T[]> {
        return Promise.all(values);
    }
}

export class JsonnetWorkerImpl implements JsonnetWorker {

    private _ctx: IWorkerContext;
    private _languageService: jsonService.LanguageService;
    private _languageSettings: JsonnetLanguageSettings;
    private _languageId: string;
    private _schemaRequestService: SchemaRequestService;
    private jsonnet: JsonnetVM;

    constructor(ctx: IWorkerContext, createData: ICreateData) {
        this._ctx = ctx;
        this._languageSettings = createData.languageSettings;
        this._languageId = createData.languageId;
        this._schemaRequestService = createData.enableSchemaRequest && defaultSchemaRequestService;
        this._languageService = jsonService.getLanguageService({
            schemaRequestService: this._schemaRequestService,
            promiseConstructor: PromiseAdapter
        });
        this._languageService.configure(this._languageSettings);
        this.jsonnet = new JsonnetVM(this._languageSettings.compilerUrl)
    }

    private getDiagnosticFromJsonnetError(error: JsonnetError) {
        let range;
        if (error.location == null) {
            range = jsonService.Range.create(0, 0, 0, 1);
        } else {
            range = error.location
        }

        return jsonService.Diagnostic.create(range, `${error.message}`, 1);
    }

    doValidation(uri: Uri): Thenable<jsonService.Diagnostic[]> {
        let extension = uri.path.split('.').pop().toLowerCase();
        if (extensions.indexOf("." + extension) === -1) {
            return Promise.resolve(new Array())
        }

        const models = this._ctx.getMirrorModels();
        const path = this.toPath(uri)
        const model = models.find(model => this.toPath(model.uri) === path)

        let documents = this._getTextDocuments(models);
        let jsonDocument, textDocument

        let compileXhr = this.jsonnet.compile(path, documents,
            this._languageSettings.extVars || {},
            this._languageSettings.tlaVars || {},
            this._languageSettings.libraries).then(result => {
            textDocument = jsonService.TextDocument.create(this.toPath(model.uri), this._languageId, model.version, result);
            jsonDocument = this._languageService.parseJSONDocument(textDocument);
            return this._languageService.doValidation(textDocument, jsonDocument);
        })

        return compileXhr.then(data => {
            let diagnostics = data.map(diagnosis => {
                // @ts-ignore - because the interface is not exposed
                let startNode = jsonDocument.getNodeFromOffset(textDocument.offsetAt(diagnosis.range.start));
                // @ts-ignore
                // let endNode = jsonDocument.getNodeFromOffset(textDocument.offsetAt(range.end));

                let startPath = Json.getNodePath(startNode)
                let range, message;
                if (startPath.length === 0) {
                    range = jsonService.Range.create(0, 0, 0, 1);
                    message = diagnosis.message;
                } else {
                    range = this.jsonnet.getLocationOfPath(path, documents[path], startPath)
                    if (range == null) {
                        range = jsonService.Range.create(0, 0, 0, 1);
                    }

                    // let value = Json.getNodeValue(startNode);
                    message = diagnosis.message + ` (${startPath.join(".")})`
                }

                return jsonService.Diagnostic.create(range, message, 1, diagnosis.code, diagnosis.source, diagnosis.relatedInformation)
            });
            console.log(diagnostics)

            return diagnostics
        }).catch(e => {
            if (e instanceof JsonnetError) {
                return new Array(this.getDiagnosticFromJsonnetError(e));
            } else {
                throw e
            }
        });
    }

    resetSchema(uri: string): Thenable<boolean> {
        return Promise.resolve(this._languageService.resetSchema(uri));
    }

    doHover(uri: string, position: jsonService.Position): Thenable<jsonService.Hover> {
        // let jsonDocument = this._languageService.parseJSONDocument(document);
        // return this._languageService.doHover(document, position, jsonDocument);
        return Promise.resolve(null);
    }

    private toPath(uri: Uri): string {
        return uri.authority + uri.path
    }

    private _getTextDocuments(models: IMirrorModel[]): FileMap {
        const files: FileMap = {}
        models.forEach(model => files[this.toPath(model.uri)] = model.getValue())
        return files
    }

    format(content: string, options: monaco.languages.FormattingOptions): Thenable<jsonService.TextEdit[]> {
        let textEdits = [];
        return Promise.resolve(textEdits);
    }

    getJsonPaths(uri: Uri, ...jsonPaths: Array<string | number>[]): Promise<Array<monaco.IRange>> {
        const filePath = this.toPath(uri)
        const model = this._ctx.getMirrorModels().find(model => this.toPath(model.uri) === filePath)
        if (model == null) {
            throw Error("uri not found")
        }

        return this.jsonnet.getLocationOfPaths(filePath, model.getValue(), jsonPaths).then(locations => {
            return locations.map(locationOfNode => {
                if(locationOfNode == null) {
                    debugger
                    return null
                } else {
                    return {
                        startLineNumber: locationOfNode.start.line + 1, startColumn: locationOfNode.start.character,
                        endLineNumber: locationOfNode.end.line + 1, endColumn: locationOfNode.end.character
                    }
                }

            })
        })
    }

    compile(uri: Uri): Promise<string> {
        const path = this.toPath(uri)
        let models = this._ctx.getMirrorModels();
        const model = models.find(model => this.toPath(model.uri) === path)
        if (model == null) {
            throw Error("uri not found")
        }

        let documents = this._getTextDocuments(models);
        return this.jsonnet.compile(path, documents,
            this._languageSettings.extVars || {},
            this._languageSettings.tlaVars || {},
            this._languageSettings.libraries)
    }
}

export interface ICreateData {
    languageId: string;
    languageSettings: JsonnetLanguageSettings;
    enableSchemaRequest: boolean
}

export function create(ctx: IWorkerContext, createData: ICreateData): JsonnetWorkerImpl {
    return new JsonnetWorkerImpl(ctx, createData);
}

export interface JsonnetLanguageSettings extends LanguageSettings {
    libraries: Library
    extVars: ExtCodes
    tlaVars: TlaVars,
    compilerUrl: string,
}
