import * as jsonService from 'vscode-json-languageservice';
import {Position} from 'vscode-languageserver-types';
import JsonnetVM from "../jsonnet";
import {SchemaFetcher} from "../jsonnetWorker";
import * as Json from 'jsonc-parser';
import * as languageServerTypes from 'vscode-languageserver-types';

const valueCommitCharacters = [',', '}', ']'];
const propertyCommitCharacters = [':'];

export class JsonnetComplete {
    private _languageService: jsonService.LanguageService;
    private promise: jsonService.PromiseConstructor;
    private jsonnet: JsonnetVM;
    private schemaFetcher: SchemaFetcher;

    constructor(_languageService: jsonService.LanguageService, promiseConstructor: jsonService.PromiseConstructor, jsonnet: JsonnetVM, schemaFetcher: SchemaFetcher) {
        this._languageService = _languageService;
        this.promise = promiseConstructor || Promise;
        this.jsonnet = jsonnet
        this.schemaFetcher = schemaFetcher
    }

    doComplete(model: monaco.worker.IMirrorModel, position: Position) {
        let text = model.getValue();

        let node
        try {
            node = this.jsonnet.getJsonPathFromLocation(text, position.line, position.character);
        } catch (e) {
            // compiler is not loaded
            return Promise.resolve({isIncomplete: false, items: []})
        }

        if (node == null) {
            let lastOutput = this.jsonnet.getLastOutput(model.uri.path);
            if(lastOutput != null) {
                node = this.jsonnet.getJsonPathFromLocation(lastOutput.jsonnet, position.line, position.character);
                text = lastOutput.jsonnet
            }
        }

        if (node == null) {
            return Promise.resolve({isIncomplete: false, items: []})
        }

        const {path, location, type} = node

        let overwriteRange: jsonService.Range;
        const textDocument = jsonService.TextDocument.create(this.toPath(model.uri), null, null, text);

        if (node && (node.type === 'LiteralString' || node.type === 'LiteralNumber' || node.type === 'LiteralBoolean' || node.type === 'LiteralNull')) {
            overwriteRange = location;
        } else {
            const offset = textDocument.offsetAt(position);
            const currentWord = this.getCurrentWord(text, offset);
            let overwriteStart = offset - currentWord.length;
            if (overwriteStart > 0 && (text[overwriteStart - 1] === "'" || text[overwriteStart - 1] === '"')) {
                overwriteStart--;
            }
            overwriteRange = jsonService.Range.create(textDocument.positionAt(overwriteStart), position);
        }

        const supportsCommitCharacters = true; //this.doesSupportsCommitCharacters(); disabled for now, waiting for new API: https://github.com/microsoft/vscode/issues/42544

        const addValue = true

        let separatorAfter = '';
        if (addValue) {
            separatorAfter = this.evaluateSeparatorAfter(text, textDocument.offsetAt(overwriteRange.end));
        }

        return this.schemaFetcher(textDocument.uri, path).then(schemas => {
            const items = schemas.flatMap(schema => {
                if (schema.type === 'object') {
                    return Object.keys(schema.properties || {}).map(property => {
                        const itemSchema = schema.properties != null ? schema.properties[property] : schema.additionalProperties;
                        let item: jsonService.CompletionItem = {
                            kind: languageServerTypes.CompletionItemKind.Method,
                            label: property,
                            insertText: this.getInsertTextForProperty(property, typeof(itemSchema) === 'boolean' ? null : itemSchema, addValue, separatorAfter),
                            insertTextFormat: jsonService.InsertTextFormat.Snippet,
                            documentation: '',
                            filterText: this.getJsonnetValue(property)
                        };
                        return item
                    })
                } else if (schema.type === 'string') {
                    if (schema.enum != null) {
                        return schema.enum.map(value => {
                            return {
                                kind: languageServerTypes.CompletionItemKind.Value,
                                label: value,
                                insertText: this.getInsertTextForValue(value, separatorAfter),
                                insertTextFormat: jsonService.InsertTextFormat.Snippet,
                                filterText: this.getJsonnetValue(value),
                                documentation: '',
                            }
                        })
                    } else {
                        console.log('enum is null')
                        return []
                    }
                } else {
                    console.log(`type is ${schema.type}`)
                    return []
                }
            }).map(suggestion => {
                let label = suggestion.label.replace(/[\n]/g, '↵');
                if (label.length > 60) {
                    const shortendedLabel = label.substr(0, 57).trim() + '...';
                    label = shortendedLabel;
                }
                if (overwriteRange && suggestion.insertText !== undefined) {
                    suggestion.textEdit = jsonService.TextEdit.replace(overwriteRange, suggestion.insertText);
                }
                if (supportsCommitCharacters) {
                    suggestion.commitCharacters = suggestion.kind === languageServerTypes.CompletionItemKind.Property ? propertyCommitCharacters : valueCommitCharacters;
                }
                suggestion.label = label;
                return suggestion
            })

            console.log('completion', items)
            return {isIncomplete: false, items: items}
        })
    }

    private getCurrentWord(text: string, offset: number) {
        let i = offset - 1;
        while (i >= 0 && ' \t\n\r\v":{[,]}'.indexOf(text.charAt(i)) === -1) {
            i--;
        }
        return text.substring(i + 1, offset);
    }


    private isDefined(val: any): val is object {
        return typeof val !== 'undefined';
    }

    private evaluateSeparatorAfter(text: string, offset: number) {
        const scanner = Json.createScanner(text, true);
        scanner.setPosition(offset);
        const token = scanner.scan();
        switch (token) {
            case Json.SyntaxKind.CommaToken:
            case Json.SyntaxKind.CloseBraceToken:
            case Json.SyntaxKind.CloseBracketToken:
            case Json.SyntaxKind.EOF:
                return '';
            default:
                return ',';
        }
    }

    private toPath(uri: monaco.Uri): string {
        return uri.authority + uri.path
    }

    private getJsonnetValue(value: string): string {
        if (/[^a-zA-Z0-9_]/.test(value)) {
            return `'${value}'`;
        } else {
            return value
        }
    }

    private getInsertTextForProperty(key: string, propertySchema: jsonService.JSONSchema | undefined, addValue: boolean, separatorAfter: string): string {

        const propertyText = this.getInsertTextForValue(key, '');
        if (!addValue) {
            return propertyText;
        }
        const resultText = propertyText + ': ';

        let value;
        let nValueProposals = 0;
        if (propertySchema) {
            if (Array.isArray(propertySchema.defaultSnippets)) {
                if (propertySchema.defaultSnippets.length === 1) {
                    const body = propertySchema.defaultSnippets[0].body;
                    if (this.isDefined(body)) {
                        debugger
                        // TODO
                        value = JSON.stringify(body)
                    }
                }
                nValueProposals += propertySchema.defaultSnippets.length;
            }
            if (propertySchema.enum) {
                if (!value && propertySchema.enum.length === 1) {
                    value = this.getInsertTextForGuessedValue(propertySchema.enum[0], '');
                }
                nValueProposals += propertySchema.enum.length;
            }
            if (this.isDefined(propertySchema.default)) {
                if (!value) {
                    value = this.getInsertTextForGuessedValue(propertySchema.default, '');
                }
                nValueProposals++;
            }
            if (Array.isArray(propertySchema.examples) && propertySchema.examples.length) {
                if (!value) {
                    value = this.getInsertTextForGuessedValue(propertySchema.examples[0], '');
                }
                nValueProposals += propertySchema.examples.length;
            }
            if (nValueProposals === 0) {
                let type = Array.isArray(propertySchema.type) ? propertySchema.type[0] : propertySchema.type;
                if (!type) {
                    if (propertySchema.properties) {
                        type = 'object';
                    } else if (propertySchema.items) {
                        type = 'array';
                    }
                }
                switch (type) {
                    case 'boolean':
                        value = '$1';
                        break;
                    case 'string':
                        value = "'$1'";
                        break;
                    case 'object':
                        value = '{$1}';
                        break;
                    case 'array':
                        value = '[$1]';
                        break;
                    case 'number':
                    case 'integer':
                        value = '${1:0}';
                        break;
                    case 'null':
                        value = '${1:null}';
                        break;
                    default:
                        return propertyText;
                }
            }
        }
        if (!value || nValueProposals > 1) {
            value = '$1';
        }

        return resultText + value + separatorAfter;
    }

    private getInsertTextForSnippetValue(value: string, separatorAfter: string): string {
        const replacer = (value: any) => {
            if (typeof value === 'string') {
                if (value[0] === '^') {
                    return value.substr(1);
                }
            }
            return this.getJsonnetValue(value);
        };
        return this.stringifyObject(value, '', replacer) + separatorAfter;
    }

    private stringifyObject(obj: any, indent: string, stringifyLiteral: (val: any) => string): string {
        if (obj !== null && typeof obj === 'object') {
            const newIndent = indent + '\t';
            if (Array.isArray(obj)) {
                if (obj.length === 0) {
                    return '[]';
                }
                let result = '[\n';
                for (let i = 0; i < obj.length; i++) {
                    result += newIndent + this.stringifyObject(obj[i], newIndent, stringifyLiteral);
                    if (i < obj.length - 1) {
                        result += ',';
                    }
                    result += '\n';
                }
                result += indent + ']';
                return result;
            } else {
                const keys = Object.keys(obj);
                if (keys.length === 0) {
                    return '{}';
                }
                let result = '{\n';
                for (let i = 0; i < keys.length; i++) {
                    const key = keys[i];

                    result += newIndent + this.getJsonnetValue(key) + ': ' + this.stringifyObject(obj[key], newIndent, stringifyLiteral);
                    if (i < keys.length - 1) {
                        result += ',';
                    }
                    result += '\n';
                }
                result += indent + '}';
                return result;
            }
        }
        return stringifyLiteral(obj);
    }

    private getInsertTextForGuessedValue(value: any, separatorAfter: string): string {
        switch (typeof value) {
            case 'object':
                if (value === null) {
                    return '${1:null}' + separatorAfter;
                }
                return this.getInsertTextForValue(value, separatorAfter);
            case 'string':
                let snippetValue = this.getJsonnetValue(value);
                snippetValue = snippetValue.substr(1, snippetValue.length - 2); // remove quotes
                snippetValue = this.getInsertTextForPlainText(snippetValue); // escape \ and }
                return '"${1:' + snippetValue + '}"' + separatorAfter;
            case 'number':
            case 'boolean':
                return '${1:' + value + '}' + separatorAfter;
        }


        return this.getInsertTextForValue(value, separatorAfter);
    }

    private jsonnetize(obj_from_json : any, depth : number = 1) {
        if (typeof obj_from_json !== "object" || Array.isArray(obj_from_json)){
            // not an object, stringify using native function
            return JSON.stringify(obj_from_json);
        }
        // Implements recursive object serialization according to JSON spec
        // but without quotes around the keys.
        let props = Object
            .keys(obj_from_json)
            .map(key => `${'\t'.repeat(depth)}${key}: ${this.jsonnetize(obj_from_json[key], depth+1)}`)
            .join(",\n");
        return `{\n${props}\n${'\t'.repeat(depth-1)}}`;
    }

    private getInsertTextForValue(value: string|object, separatorAfter: string): string {
        let text;
        if(typeof(value) === 'string') {
            text = this.getJsonnetValue(value);
        } else {
            text = this.jsonnetize(value)
            console.log(text)
        }

        if (text === '{}') {
            return '{$1}' + separatorAfter;
        } else if (text === '[]') {
            return '[$1]' + separatorAfter;
        }
        return this.getInsertTextForPlainText(text + separatorAfter);
    }

    private getInsertTextForPlainText(text: string): string {
        return text.replace(/[\\\$\}]/g, '\\$&');   // escape $, \ and }
    }
}
