'use strict';

import {LanguageServiceDefaultsImpl} from './monaco.contribution';

import * as jsonService from 'vscode-json-languageservice';
import {JsonnetWorkerImpl} from "./jsonnetWorker";
import Uri = monaco.Uri;
import Thenable = monaco.Thenable;
import IDisposable = monaco.IDisposable;
import CancellationToken = monaco.CancellationToken;
import Position = monaco.Position;
import Range = monaco.Range;
import ITextModel = monaco.editor.ITextModel;


export interface WorkerAccessor {
    (...more: Uri[]): Promise<JsonnetWorkerImpl>
}

export class DiagnosticsAdapter {

    private _disposables: IDisposable[] = [];
    private _listener: { [uri: string]: IDisposable } = Object.create(null);

    constructor(private _languageId: string, private _worker: WorkerAccessor, defaults: LanguageServiceDefaultsImpl) {
        const onModelAdd = (model: monaco.editor.IModel): void => {
            let modeId = model.getModeId();
            if (modeId !== this._languageId) {
                // we need to process all the models available in editor since the jsonnet files may include markdown, sql and text files.
                // return;
            }

            let handle;
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
        })
    }
}


function toSeverity(lsSeverity: number): monaco.MarkerSeverity {
    switch (lsSeverity) {
        case jsonService.DiagnosticSeverity.Error:
            return monaco.MarkerSeverity.Error;
        case jsonService.DiagnosticSeverity.Warning:
            return monaco.MarkerSeverity.Warning;
        case jsonService.DiagnosticSeverity.Information:
            return monaco.MarkerSeverity.Info;
        case jsonService.DiagnosticSeverity.Hint:
            return monaco.MarkerSeverity.Hint;
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
    return {character: position.column - 1, line: position.lineNumber - 1};
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

    return {value: '```' + entry.language + '\n' + entry.value + '\n```\n'};
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

export class DeclarationProvider implements monaco.languages.DefinitionProvider {
    private _worker: WorkerAccessor;
    private modelCreator: any;

    constructor(worker: WorkerAccessor, modelCreator: (value: string, language?: string, uri?: Uri) => ITextModel) {
        this._worker = worker
        this.modelCreator = modelCreator
    }

    provideDefinition(model: monaco.editor.ITextModel, position: Position, token: CancellationToken): monaco.languages.ProviderResult<monaco.languages.Location | monaco.languages.LocationLink[]> {
        return this._worker().then(worker => {
            return worker.getDefinition(model.uri, fromPosition(position));
        }).then(result => {
            let uri = monaco.Uri.from({path: model.uri.path + '.json', scheme: 'preview'});
            let previewModel = monaco.editor.getModel(uri);
            if (previewModel == null) {
                this.modelCreator(result.content, 'json', uri);
            } else {
                previewModel.setValue(result.content)
            }

            return {
                uri: uri,
                range: toRange(result.range)
            };
        })
    }
}

export class HoverAdapter implements monaco.languages.HoverProvider {

    constructor(private _worker: WorkerAccessor) {
        this._worker = _worker
    }

    provideHover(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.Hover> {
        let resource = model.uri;

        return this._worker(resource).then(worker => {
            return worker.doHover(resource, fromPosition(position));
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

function toCompletionItemKind(kind: number): monaco.languages.CompletionItemKind {
    let mItemKind = monaco.languages.CompletionItemKind;

    switch (kind) {
        case jsonService.CompletionItemKind.Text:
            return mItemKind.Text;
        case jsonService.CompletionItemKind.Method:
            return mItemKind.Method;
        case jsonService.CompletionItemKind.Function:
            return mItemKind.Function;
        case jsonService.CompletionItemKind.Constructor:
            return mItemKind.Constructor;
        case jsonService.CompletionItemKind.Field:
            return mItemKind.Field;
        case jsonService.CompletionItemKind.Variable:
            return mItemKind.Variable;
        case jsonService.CompletionItemKind.Class:
            return mItemKind.Class;
        case jsonService.CompletionItemKind.Interface:
            return mItemKind.Interface;
        case jsonService.CompletionItemKind.Module:
            return mItemKind.Module;
        case jsonService.CompletionItemKind.Property:
            return mItemKind.Property;
        case jsonService.CompletionItemKind.Unit:
            return mItemKind.Unit;
        case jsonService.CompletionItemKind.Value:
            return mItemKind.Value;
        case jsonService.CompletionItemKind.Enum:
            return mItemKind.Enum;
        case jsonService.CompletionItemKind.Keyword:
            return mItemKind.Keyword;
        case jsonService.CompletionItemKind.Snippet:
            return mItemKind.Snippet;
        case jsonService.CompletionItemKind.Color:
            return mItemKind.Color;
        case jsonService.CompletionItemKind.File:
            return mItemKind.File;
        case jsonService.CompletionItemKind.Reference:
            return mItemKind.Reference;
    }
    return mItemKind.Property;
}

interface InsertReplaceEdit {
    /**
     * The string to be inserted.
     */
    newText: string;
    /**
     * The range if the insert is requested
     */
    insert: jsonService.Range;
    /**
     * The range if the replace is requested.
     */
    replace: jsonService.Range;
}

function isInsertReplaceEdit(
    edit: jsonService.TextEdit | InsertReplaceEdit
): edit is InsertReplaceEdit {
    return (
        typeof (<InsertReplaceEdit>edit).insert !== 'undefined' &&
        typeof (<InsertReplaceEdit>edit).replace !== 'undefined'
    );
}

export class CompletionAdapter implements monaco.languages.CompletionItemProvider {

    constructor(private _worker: WorkerAccessor) {
    }

    public get triggerCharacters(): string[] {
        return [' ', ':', '\n', "'"];
    }

    provideCompletionItems(model: monaco.editor.IReadOnlyModel, position: Position, context: monaco.languages.CompletionContext, token: CancellationToken): Thenable<monaco.languages.CompletionList> {
        const resource = model.uri;

        return this._worker(resource).then(worker => {
            return worker.doComplete(resource, fromPosition(position));
        }).then(info => {
            if (!info) {
                return;
            }
            const wordInfo = model.getWordUntilPosition(position);
            const wordRange = new Range(position.lineNumber, wordInfo.startColumn, position.lineNumber, wordInfo.endColumn);

            let items: monaco.languages.CompletionItem[] = info.items.map(entry => {
                let item: monaco.languages.CompletionItem = {
                    label: entry.label,
                    insertText: entry.insertText || entry.label,
                    sortText: entry.sortText,
                    filterText: entry.filterText,
                    documentation: entry.documentation,
                    detail: entry.detail,
                    range: wordRange,
                    kind: toCompletionItemKind(entry.kind),
                };
                if (entry.textEdit) {
                    if (isInsertReplaceEdit(entry.textEdit)) {
                        item.range = {
                            insert: toRange(entry.textEdit.insert),
                            replace: toRange(entry.textEdit.replace)
                        };
                    } else {
                        item.range = toRange(entry.textEdit.range);
                    }
                    item.insertText = entry.textEdit.newText;
                }
                if (entry.additionalTextEdits) {
                    item.additionalTextEdits = entry.additionalTextEdits.map(toTextEdit)
                }
                if (entry.insertTextFormat === jsonService.InsertTextFormat.Snippet) {
                    item.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
                }
                return item;
            });

            return {
                isIncomplete: info.isIncomplete,
                suggestions: items
            };
        });
    }
}

export class DocumentFormattingEditProvider implements monaco.languages.DocumentFormattingEditProvider {

    constructor(private _worker: WorkerAccessor) {
    }

    public provideDocumentFormattingEdits(model: monaco.editor.IReadOnlyModel, options: monaco.languages.FormattingOptions, token: CancellationToken): Thenable<monaco.editor.ISingleEditOperation[]> {
        const resource = model.uri;

        return this._worker(resource).then(worker => {
            // @ts-ignore
            const workerImpl = worker as JsonnetWorkerImpl
            return workerImpl.format(resource, options).then(edits => {
                if (!edits || edits.length === 0) {
                    return;
                }
                return edits.map(toTextEdit);
            });
        });
    }
}

function toTextEdit(textEdit: jsonService.TextEdit): monaco.editor.ISingleEditOperation {
    if (!textEdit) {
        return void 0;
    }
    return {
        range: toRange(textEdit.range),
        text: textEdit.newText
    }
}
