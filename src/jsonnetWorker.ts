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
import {JsonnetHover} from "./service/jsonnetHover";
import {JsonnetComplete} from "./service/jsonnetComplete";

let defaultSchemaRequestService;
if (typeof fetch !== 'undefined') {
    defaultSchemaRequestService = function (url) {
        return fetch(url).then(response => {
            return response.text()
        })
    };
}

type Definition = {
    range: jsonService.Range,
    content: string
}

export type SchemaFetcher = (uri: string, jsonPath: (Array<string | number> | undefined)) => Thenable<jsonService.JSONSchema[]>

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
    private hoverService: JsonnetHover;
    private completeService: JsonnetComplete;

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
        this.hoverService = new JsonnetHover(this._languageService, PromiseAdapter, this.jsonnet, this.getSchema)
        this.completeService = new JsonnetComplete(this._languageService, PromiseAdapter, this.jsonnet, this.getSchema)
    }

    getSchema(uri: string, jsonPath: Array<string | number> | undefined): Thenable<jsonService.JSONSchema[]> {
        const textDocument = jsonService.TextDocument.create(uri, this._languageId, 1, "{}");
        let jsonDocument = {
            root: null, getNodeFromOffset: null, getMatchingSchemas: function (data) {
                return [{schema: data, inverted: false}]
            }
        };

        return this._languageService.getMatchingSchemas(textDocument, jsonDocument, null).then(schemas => {
            return schemas.map(matchingSchema => {
                let schema = matchingSchema.schema
                if(jsonPath != null && schema != null) {
                    for (let i = 0; i < jsonPath.length; i++) {
                        const path = jsonPath[i]
                        if (schema.type === 'object') {
                            const ref = schema.properties != null ? schema.properties[path] : schema.additionalProperties
                            if (typeof (ref) !== 'boolean') {
                                schema = ref
                            }
                        } else if (schema.type === 'array') {
                            const ref = schema.items
                            if (!Array.isArray(ref) && typeof (ref) !== 'boolean') {
                                schema = schema.items as jsonService.JSONSchema
                            }
                        }
                    }
                }
                return schema
            }).filter(schema => {
                return schema != null
            })
        })
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
            this._languageSettings.libraries)
            .then(result => {
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
                    range = jsonService.Range.create(0, 0, Number.MAX_VALUE, Number.MAX_VALUE);
                    message = diagnosis.message;
                } else {
                    range = this.jsonnet.getLocationOfPath(path, documents[path], startPath, false)
                    if (range == null) {
                        range = jsonService.Range.create(0, 0, 0, 1);
                    }
                    // else if(range.end.line - range.start.line > 1) {
                    //     range = jsonService.Range.create(range.start.line, range.start.character, range.start.line, 0);
                    // }

                    // let value = Json.getNodeValue(startNode);
                    message = diagnosis.message + ` (${startPath.join(".")})`
                }

                return jsonService.Diagnostic.create(range, message, 2, 1, diagnosis.source, diagnosis.relatedInformation)
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
        return this.completeService.doComplete(model, position)
    }

    doHover(uri: monaco.Uri, position: jsonService.Position): Thenable<jsonService.Hover> {
        const uriPath = this.toPath(uri)
        let data = this.jsonnet.getLastOutput(uri.path);
        if (data == null) {
            return null
        }

        const textDocument = jsonService.TextDocument.create(uriPath, this._languageId, 1, data.jsonnet);

        return this.hoverService.doHover(textDocument, position)
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
        return this.jsonnet.format(uri.path, content).then(result => {
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
                if (locationOfNode == null) {
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

    getDefinition(uri: monaco.Uri, position: jsonService.Position): Promise<Definition> {
        const path = this.toPath(uri)
        const model = this._ctx.getMirrorModels().find(model => this.toPath(model.uri) === path)

        return this.compile(uri).then(content => {
            let location = this.jsonnet.getJsonPathFromLocation(model.getValue(), position.line, position.character);

            const textDocument = jsonService.TextDocument.create(path, this._languageId, model.version, content);
            let jsonDocument = this._languageService.parseJSONDocument(textDocument);

            let range;
            if(location.path.length > 0) {
                let node = Json.findNodeAtLocation(jsonDocument.root, location.path);
                if(node != null) {
                    range = jsonService.Range.create(textDocument.positionAt(node.offset), textDocument.positionAt(node.offset + node.length));
                }
            }

            if(range == null) {
                let noPosition = jsonService.Position.create(0, 0);
                range = jsonService.Range.create(noPosition, noPosition);
            }

            return {content, range: range}
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
