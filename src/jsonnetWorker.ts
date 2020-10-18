/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import Thenable = monaco.Thenable;
import IWorkerContext = monaco.worker.IWorkerContext;
import IMirrorModel = monaco.worker.IMirrorModel;
import Library = monaco.languages.jsonnet.Library;
import JsonnetWorker = monaco.languages.jsonnet.JsonnetWorker;
import ExtCodes = monaco.languages.jsonnet.ExtCodes;
import TlaVars = monaco.languages.jsonnet.TlaVars;
import JsonnetVM, {FileMap, JsonnetError} from './jsonnet';
import * as Json from 'jsonc-parser';

import * as jsonService from 'vscode-json-languageservice';

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
    private _schemaRequestService: jsonService.SchemaRequestService;
    private jsonnet: JsonnetVM;

    constructor(ctx: IWorkerContext, createData: ICreateData) {
        this._ctx = ctx;
        this._languageSettings = createData.languageSettings;
        this._languageId = createData.languageId;
        this._schemaRequestService = createData.enableSchemaRequest && defaultSchemaRequestService;
        this._languageService = jsonService.getLanguageService({
            schemaRequestService: this._schemaRequestService,
            contributions: [],
            promiseConstructor: PromiseAdapter
        });
        this._languageService.configure(this._languageSettings);
        this.jsonnet = new JsonnetVM(this._languageSettings.compilerUrl)

        // const textDocument = jsonService.TextDocument.create(this.toPath(monaco.Uri.parse("git://a.model.jsonnet")), this._languageId, 1, "{}");
        // let jsonDocument = {root: null, getNodeFromOffset: null, getMatchingSchemas: function(data) {
        //         return [{schema: data, inverted: false}]
        //     }};
        // this._languageService.getMatchingSchemas(textDocument, jsonDocument, null).then(data => {
        // })
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

    doValidation(uri: monaco.Uri): Thenable<jsonService.Diagnostic[]> {
        let extension = uri.path.split('.').pop().toLowerCase();
        if (extensions.indexOf("." + extension) === -1) {
            return Promise.resolve(new Array())
        }
        const path = this.toPath(uri)

        const models = this._ctx.getMirrorModels();
        let documents = this._getTextDocuments(models);

        const model = models.find(model => this.toPath(model.uri) === path)
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
                    range = this.jsonnet.getLocationOfPath(path, documents[path], startPath, false)
                    if (range == null) {
                        range = jsonService.Range.create(0, 0, 0, 1);
                    }

                    // let value = Json.getNodeValue(startNode);
                    message = diagnosis.message + ` (${startPath.join(".")})`
                }
                // TODO
                // return jsonService.Diagnostic.create(range, message, 1, diagnosis.code, diagnosis.source, diagnosis.relatedInformation)
                return jsonService.Diagnostic.create(range, message, 1, 1, diagnosis.source, diagnosis.relatedInformation)
            });
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

    doComplete(uri: monaco.Uri, position: jsonService.Position): Thenable<jsonService.CompletionList> {
        const uriPath = this.toPath(uri)
        const model = this._ctx.getMirrorModels().find(model => this.toPath(model.uri) === uriPath)

        let lastOutput = this.jsonnet.getLastOutput(uri.path);
        if(lastOutput == null) {
            return Promise.resolve({isIncomplete: false, items: []})
        }

        const json = lastOutput.json.replace(/\n/g, '')
        const document = jsonService.TextDocument.create(uriPath, this._languageId, model.version, json);
        let jsonDocument = this._languageService.parseJSONDocument(document);
        let jsonPathFromLocation = this.jsonnet.getJsonPathFromLocation(lastOutput.jsonnet, position.line, position.character);
        if(!jsonPathFromLocation) {
            return Promise.resolve({isIncomplete: false, items: []})
        }
        let node = Json.findNodeAtLocation(jsonDocument.root, jsonPathFromLocation);
        let jsonPos = {character: node.offset, line: 0};
        return this._languageService.doComplete(document, jsonPos, jsonDocument)
    }

    doHover(uri: monaco.Uri, position: jsonService.Position): Thenable<jsonService.Hover> {
        const uriPath = this.toPath(uri)
        const model = this._ctx.getMirrorModels().find(model => this.toPath(model.uri) === uriPath)
        let value = model.getValue();

        let data = this.jsonnet.getLastOutput(uri.path);
        if(data == null) {
            return null
        }

        const json = data.json.replace(/\n/g, '')
        const document = jsonService.TextDocument.create(uriPath, this._languageId, model.version, json);
        let jsonDocument = this._languageService.parseJSONDocument(document);
        let jsonPathFromLocation = this.jsonnet.getJsonPathFromLocation(value, position.line, position.character);
        if(jsonPathFromLocation == null) {
            return null
        }
        let node = Json.findNodeAtLocation(jsonDocument.root, jsonPathFromLocation);
        let jsonPos = {character: node.offset, line: 0};
        return this._languageService.doHover(document, jsonPos, jsonDocument).then(d => {
            return {contents: d.contents, range: {start: {line: position.line, character: position.character - 1}, end: {line: position.line, character: position.character + 1}}}
        })
    }

    private toPath(uri: monaco.Uri): string {
        return uri.authority + uri.path
    }

    private _getTextDocuments(models: IMirrorModel[]): FileMap {
        const files: FileMap = {}
        models.forEach(model => files[this.toPath(model.uri)] = model.getValue())
        return files
    }

    format(uri: monaco.Uri, options: monaco.languages.FormattingOptions): Thenable<jsonService.TextEdit[]> {
        const uriPath = this.toPath(uri)
        const model = this._ctx.getMirrorModels().find(model => this.toPath(model.uri) === uriPath)
        let content = model.getValue();
        return this.jsonnet.format(content).then(result => {
            return [jsonService.TextEdit.replace(jsonService.Range.create(0, 0, Number.MAX_VALUE, Number.MAX_VALUE), result)]
        })
    }

    getJsonPaths(uri: monaco.Uri, ...jsonPaths: Array<string | number>[]): Promise<Array<monaco.IRange>> {
        const filePath = this.toPath(uri)
        const model = this._ctx.getMirrorModels().find(model => this.toPath(model.uri) === filePath)
        if (model == null) {
            throw Error("uri not found")
        }

        return this.jsonnet.getLocationOfPaths(filePath, model.getValue(), jsonPaths).then(locations => {
            return locations.map(locationOfNode => {
                if(locationOfNode == null) {
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

    compile(uri: monaco.Uri): Promise<string> {
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

export interface JsonnetLanguageSettings extends jsonService.LanguageSettings {
    libraries: Library
    extVars: ExtCodes
    tlaVars: TlaVars,
    compilerUrl: string,
}
