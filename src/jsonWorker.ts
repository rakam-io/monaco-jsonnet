/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import Thenable = monaco.Thenable;
import IWorkerContext = monaco.worker.IWorkerContext;
import Jsonnet from 'jsonnet-compiler';
import * as Json from 'jsonc-parser';

import * as jsonService from 'vscode-json-languageservice';
import {Uri, worker} from "monaco-editor-core";
import IMirrorModel = worker.IMirrorModel;
import {SchemaRequestService} from "vscode-json-languageservice";
import {FailedParsedDocument} from "jsonnet-compiler/lib/umd/lexical-analysis/service";
import {ParseFailure, LexFailure} from "jsonnet-compiler/lib/umd/lexical-analysis/service";

let jsonnet = new Jsonnet();

let defaultSchemaRequestService;
if (typeof fetch !== 'undefined') {
	defaultSchemaRequestService = function (url) { return fetch(url).then(response => response.text()) };
}

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

export class JSONWorker {

	private _ctx: IWorkerContext;
	private _languageService: jsonService.LanguageService;
	private _languageSettings: jsonService.LanguageSettings;
	private _languageId: string;
	private _schemaRequestService: SchemaRequestService;

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
	}

	doValidation(uri: Uri): Thenable<jsonService.Diagnostic[]> {
		const models = this._ctx.getMirrorModels();
		const path = this.toPath(uri)
		const model = models.filter(model => this.toPath(model.uri) === path)[0]
		let documents = this._getTextDocuments(models);
		let fileContent = documents.get(path);

		let parsedDocument = jsonnet.parse(path, fileContent);
		if(parsedDocument instanceof FailedParsedDocument) {
			let msg, loc
			if(parsedDocument.parse instanceof LexFailure) {
				const error = (parsedDocument.parse as LexFailure).lexError;
				loc = error.loc;
				msg = error.msg;
			} else
			if(parsedDocument.parse instanceof ParseFailure) {
				const error = (parsedDocument.parse as ParseFailure).parseError;
				loc = error.loc;
				msg = error.msg;
			} else {
				throw Error()
			}

			const range = jsonService.Range.create(loc.begin.line - 1, loc.begin.column - 1, loc.end.line - 1, loc.end.column);
			const diagnostic = jsonService.Diagnostic.create(range, `INVALID SYNTAX: ${msg}`, 1, 0);
			return Promise.resolve(new Array(diagnostic))
		}

		let extCodes : Map<string, string> = new Map()
		let output;
		try {
			output = jsonnet.compile(path, fileContent, documents, extCodes)
		} catch (e) {
			return

			return Promise.resolve(new Array())
		}

		const textDocument = jsonService.TextDocument.create(this.toPath(model.uri), this._languageId, model.version, output);

		const jsonDocument = this._languageService.parseJSONDocument(textDocument);
		let validationXhr = this._languageService.doValidation(textDocument, jsonDocument);

		return validationXhr.then(data => {
			return data.map(diagnosis => {
				// @ts-ignore - because the interface is not exposed
				let startNode = jsonDocument.getNodeFromOffset(textDocument.offsetAt(diagnosis.range.start));
				// @ts-ignore
				// let endNode = jsonDocument.getNodeFromOffset(textDocument.offsetAt(range.end));

				let startPath = Json.getNodePath(startNode)
				let range, message;
				if(startPath.length === 0) {
					range = jsonService.Range.create(0, 0, 0, 1);
					message = diagnosis.message;
				} else {
					// @ts-ignore
					let jsonnetPath = jsonnet.findNodeFromJsonPath(parsedDocument.parse, startPath);
					if(jsonnetPath == null) {
						range = jsonService.Range.create(0, 0, 0, 1);
					} else {
						let begin = jsonnetPath.loc.begin;
						let end = jsonnetPath.loc.end;
						range = jsonService.Range.create(begin.line - 1, begin.column - 1, end.line - 1, end.column);
					}

					let value = Json.getNodeValue(startNode);
					message = diagnosis.message + '\n' + value
				}

				return jsonService.Diagnostic.create(range, message, diagnosis.severity, diagnosis.code, diagnosis.source, diagnosis.relatedInformation)
			})
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

	private toPath(uri : Uri): string {
		return uri.authority + uri.path
	}

	private _getTextDocuments(models : IMirrorModel[]): Map<string, string> {
		const files : Map<string, string> = new Map()

		models.forEach(model => {
			files.set(this.toPath(model.uri), model.getValue())
		})

		return files
	}
}

export interface ICreateData {
	languageId: string;
	languageSettings: jsonService.LanguageSettings;
	enableSchemaRequest: boolean;
}

export function create(ctx: IWorkerContext, createData: ICreateData): JSONWorker {
	return new JSONWorker(ctx, createData);
}
