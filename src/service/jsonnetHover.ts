import * as jsonService from 'vscode-json-languageservice';
import {Hover, MarkedString, Position} from 'vscode-languageserver-types';
import JsonnetVM from "../jsonnet";
import {SchemaFetcher} from "../jsonnetWorker";

export class JsonnetHover {
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

    public doHover(document: jsonService.TextDocument, position: Position): monaco.Thenable<Hover | null> {
        let nodeLocation;
        try {
            nodeLocation = this.jsonnet.getJsonPathFromLocation(document.getText(), position.line, position.character);
        } catch (e) {
            // compiler is not loaded
            return null
        }

        if (nodeLocation == null) {
            return null
        }

        let {type, location, path} = nodeLocation;

        const createHover = (contents: MarkedString[]) => {
            const result: Hover = {
                contents: contents,
                range: location
            };
            return result;
        };

        return this.schemaFetcher(document.uri, path).then(matchingSchemas => {
            let title: string | undefined = undefined;
            let markdownDescription: string | undefined = undefined;
            let markdownEnumValueDescription: string | undefined = undefined, enumValue: string | undefined = undefined;
            matchingSchemas.every((s) => {
                title = title || s.title;
                markdownDescription = markdownDescription || s.markdownDescription || toMarkdown(s.description);
                if (s.enum) {
                    // TODO: find out a way to return current word
                    // const idx = s.enum.indexOf(currentWord);
                    // if (s.markdownEnumDescriptions) {
                    //     markdownEnumValueDescription = s.markdownEnumDescriptions[idx];
                    // } else if (s.enumDescriptions) {
                    //     markdownEnumValueDescription = toMarkdown(s.enumDescriptions[idx]);
                    // }
                    // if (markdownEnumValueDescription) {
                    //     enumValue = s.enum[idx];
                    //     if (typeof enumValue !== 'string') {
                    //         enumValue = JSON.stringify(enumValue);
                    //     }
                    // }
                }
                return true;
            });
            let result = '';
            if (title) {
                result = toMarkdown(title);
            }
            if (markdownDescription) {
                if (result.length > 0) {
                    result += "\n\n";
                }
                result += markdownDescription;
            }
            if (markdownEnumValueDescription) {
                if (result.length > 0) {
                    result += "\n\n";
                }
                result += `\`${toMarkdownCodeBlock(enumValue!)}\`: ${markdownEnumValueDescription}`;
            }
            let hover = createHover([result]);
            return hover;
        });
    }
}

function toMarkdown(plain: string): string;
function toMarkdown(plain: string | undefined): string | undefined;
function toMarkdown(plain: string | undefined): string | undefined {
    if (plain) {
        const res = plain.replace(/([^\n\r])(\r?\n)([^\n\r])/gm, '$1\n\n$3'); // single new lines to \n\n (Markdown paragraph)
        return res.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&"); // escape markdown syntax tokens: http://daringfireball.net/projects/markdown/syntax#backslash
    }
    return undefined;
}

function toMarkdownCodeBlock(content: string) {
    // see https://daringfireball.net/projects/markdown/syntax#precode
    if (content.indexOf('`') !== -1) {
        return '`` ' + content + ' ``';
    }
    return content;
}
