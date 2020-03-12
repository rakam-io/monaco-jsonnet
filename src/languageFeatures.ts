/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { LanguageServiceDefaultsImpl } from './monaco.contribution';
import { JSONWorker } from './jsonWorker';

import * as jsonService from 'vscode-json-languageservice';

import Uri = monaco.Uri;
import Thenable = monaco.Thenable;
import IDisposable = monaco.IDisposable;
import CancellationToken = monaco.CancellationToken;
import Position = monaco.Position;
import Range = monaco.Range;
import IRange = monaco.IRange;

export interface WorkerAccessor {
	(...more: Uri[]): Thenable<JSONWorker>
}


export class DiagnosticsAdapter {

	private _disposables: IDisposable[] = [];
	private _listener: { [uri: string]: IDisposable } = Object.create(null);

	constructor(private _languageId: string, private _worker: WorkerAccessor, defaults: LanguageServiceDefaultsImpl) {
		const onModelAdd = (model: monaco.editor.IModel): void => {
			let modeId = model.getModeId();
			if (modeId !== this._languageId) {
				return;
			}

			let handle: number;
			this._listener[model.uri.toString()] = model.onDidChangeContent(() => {
				clearTimeout(handle);
				handle = setTimeout(() => this._doValidate(model.uri, modeId), 500);
			});

			this._doValidate(model.uri, modeId);
		};

		const onModelRemoved = (model: monaco.editor.IModel): void => {
			monaco.editor.setModelMarkers(model, this._languageId, []);
			let uriStr = model.uri.toString();
			let listener = this._listener[uriStr];
			if (listener) {
				listener.dispose();
				delete this._listener[uriStr];
			}
		};

		this._disposables.push(monaco.editor.onDidCreateModel(onModelAdd));
		this._disposables.push(monaco.editor.onWillDisposeModel(model => {
			onModelRemoved(model);
			this._resetSchema(model.uri);
		}));
		this._disposables.push(monaco.editor.onDidChangeModelLanguage(event => {
			onModelRemoved(event.model);
			onModelAdd(event.model);
			this._resetSchema(event.model.uri);
		}));

		this._disposables.push(defaults.onDidChange(_ => {
			monaco.editor.getModels().forEach(model => {
				if (model.getModeId() === this._languageId) {
					onModelRemoved(model);
					onModelAdd(model);
				}
			});
		}));

		this._disposables.push({
			dispose: () => {
				monaco.editor.getModels().forEach(onModelRemoved);
				for (let key in this._listener) {
					this._listener[key].dispose();
				}
			}
		});

		monaco.editor.getModels().forEach(onModelAdd);
	}

	public dispose(): void {
		this._disposables.forEach(d => d && d.dispose());
		this._disposables = [];
	}

	private _resetSchema(resource: Uri): void {
		this._worker().then(worker => {
			worker.resetSchema(resource.toString());
		});
	}

	private _doValidate(resource: Uri, languageId: string): void {
		this._worker(resource).then(worker => {
			return worker.doValidation(resource).then(diagnostics => {
				const markers = diagnostics.map(d => toDiagnostics(resource, d));
				let model = monaco.editor.getModel(resource);
				if (model && model.getModeId() === languageId) {
					monaco.editor.setModelMarkers(model, languageId, markers);
				}
			});
		}).then(undefined, err => {
			console.error(err);
		});
	}
}


function toSeverity(lsSeverity: number): monaco.MarkerSeverity {
	switch (lsSeverity) {
		case jsonService.DiagnosticSeverity.Error: return monaco.MarkerSeverity.Error;
		case jsonService.DiagnosticSeverity.Warning: return monaco.MarkerSeverity.Warning;
		case jsonService.DiagnosticSeverity.Information: return monaco.MarkerSeverity.Info;
		case jsonService.DiagnosticSeverity.Hint: return monaco.MarkerSeverity.Hint;
		default:
			return monaco.MarkerSeverity.Info;
	}
}

function toDiagnostics(resource: Uri, diag: jsonService.Diagnostic): monaco.editor.IMarkerData {
	let code = typeof diag.code === 'number' ? String(diag.code) : <string>diag.code;

	return {
		severity: toSeverity(diag.severity),
		startLineNumber: diag.range.start.line + 1,
		startColumn: diag.range.start.character + 1,
		endLineNumber: diag.range.end.line + 1,
		endColumn: diag.range.end.character + 1,
		message: diag.message,
		code: code,
		source: diag.source
	};
}

function fromPosition(position: Position): jsonService.Position {
	if (!position) {
		return void 0;
	}
	return { character: position.column - 1, line: position.lineNumber - 1 };
}

function isMarkupContent(thing: any): thing is jsonService.MarkupContent {
	return thing && typeof thing === 'object' && typeof (<jsonService.MarkupContent>thing).kind === 'string';
}

function toMarkdownString(entry: jsonService.MarkupContent | jsonService.MarkedString): monaco.IMarkdownString {
	if (typeof entry === 'string') {
		return {
			value: entry
		};
	}
	if (isMarkupContent(entry)) {
		if (entry.kind === 'plaintext') {
			return {
				value: entry.value.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&')
			};
		}
		return {
			value: entry.value
		};
	}

	return { value: '```' + entry.language + '\n' + entry.value + '\n```\n' };
}

function toMarkedStringArray(contents: jsonService.MarkupContent | jsonService.MarkedString | jsonService.MarkedString[]): monaco.IMarkdownString[] {
	if (!contents) {
		return void 0;
	}
	if (Array.isArray(contents)) {
		return contents.map(toMarkdownString);
	}
	return [toMarkdownString(contents)];
}

function toRange(range: jsonService.Range): Range {
	if (!range) {
		return void 0;
	}
	return new Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
}

export class HoverAdapter implements monaco.languages.HoverProvider {

	constructor(private _worker: WorkerAccessor) {
	}

	provideHover(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.Hover> {
		let resource = model.uri;

		return this._worker(resource).then(worker => {
			return worker.doHover(resource.toString(), fromPosition(position));
		}).then(info => {
			if (!info) {
				return;
			}
			return <monaco.languages.Hover>{
				range: toRange(info.range),
				contents: toMarkedStringArray(info.contents)
			};
		});
	}
}
