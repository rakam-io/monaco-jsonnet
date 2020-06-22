'use strict';

import jsonnetPackage, {errors} from 'gopher-jsonnet'
import * as jsonService from "vscode-json-languageservice";
import normalize from './path-normalize'
import Library = monaco.languages.jsonnet.Library;

type FileMap = Map<string, string>;
export type AST = object;
type Loc = object;

export class JsonnetError {
    loc: object;
    message: string;

    constructor(message: string, loc: Loc | null) {
        this.message = message;
        this.loc = loc
    }
}

type nodeType = '*ast.Array' | '*ast.Binary' | '*ast.Unary' | '*ast.Conditional'
    | '*ast.DesugaredObject' | '*ast.Error' | '*ast.Index' | '*ast.Import' | '*ast.ImportStr'
    | '*ast.LiteralBoolean' | '*ast.LiteralNull' | '*ast.LiteralNumber' | '*ast.LiteralString' | '*ast.Local'
    | '*ast.Self' | '*ast.Var' | '*ast.SuperIndex' | '*ast.InSuper' | '*ast.Function' | '*ast.Apply'


function stripUtf8(input) {
    var output = "";
    for (var i = 0; i < input.length; i++) {
        if (input.charCodeAt(i) <= 127) {
            output += input.charAt(i);
        }
    }
    return output;
}

export default class JsonnetVM {
    private vm: any;
    // I could not find a way to create the error instance using Gopherjs API so we create a dummy error
    private dummyError: any;
    private astCache = new LruCache<AST>()

    constructor() {
        this.vm = jsonnetPackage.MakeVM()
    }

    get lazyDummyError() {
        if (this.dummyError == null) {
            this.dummyError = jsonnetPackage.SnippetToAST("test", "1")[1];
        }
        return this.dummyError
    }

    parse(path: string, rawContent: string): AST {
        let ast;
        if (this.astCache.get(rawContent) != null) {
            ast = this.astCache.get(rawContent);
        } else {
            ast = jsonnetPackage.SnippetToAST(path, stripUtf8(rawContent))
            this.astCache.put(rawContent, ast)
        }
        let errorType = ast[1].constructor.string
        if (errorType != null) {
            if (errorType == 'errors.staticError') {
                throw new JsonnetError(ast[1].$val.msg, ast[1].$val.loc)
            } else {
                throw new JsonnetError("Unknown Error", null)
            }
        }

        return ast[0]
    }

    private getDirectoryFromPath(path: string): string {
        return path.substring(0, path.lastIndexOf("/") + 1)
    }

    compile(path: string, files: FileMap, extCodes: Map<string, string>, tlaVars: Map<string, string>, libraries: Array<Library>, ast: AST): string {
        Object.keys(extCodes).forEach(key => {
            this.vm.ExtCode(key, JSON.stringify(stripUtf8(extCodes[key])))
        })

        const importerCache = {}

        this.vm.Importer({
            Import: (importedFrom, importedPath) => {
                let target;
                if (importedPath.startsWith('/')) {
                    target = normalize(importedPath)
                } else {
                    target = normalize(this.getDirectoryFromPath(importedFrom) + '/' + importedPath);
                }

                target = target.replace(/^\/+|\/+$/g, '')

                let content = files.get(target);
                if (content == null) {
                    content = libraries.filter(library => library.name === importedPath).map(library => library.content)[0]
                }

                if (content != null) {
                    if (importerCache[target] == null) {
                        importerCache[target] = [jsonnetPackage.MakeContents(content), importedPath, this.lazyDummyError]
                    }

                    return importerCache[target]
                } else {

                    return [jsonnetPackage.MakeContents(""), importedPath, errors.New(`Error compiling file ${importedFrom}: Imported path ${target} not found`)]
                }
            }
        })

        let result
        try {
            result = this.vm.Evaluate(ast);
        } catch (e) {
            console.error(e)
            throw new JsonnetError("An unknown error occurred while compiling Jsonnet", null)
        }

        if (result[0] === '') {
            let errorType = result[1].constructor.string;
            if (errorType === '*errors.errorString') {
                throw new JsonnetError(result[1].s, null)
            }

            if (errorType === 'jsonnet.RuntimeError') {
                const stacktrace = result[1].$val.StackTrace
                const loc = stacktrace != null ? stacktrace.$array[stacktrace.$array.length - 1].Loc : null
                throw new JsonnetError(result[1].$val.Msg, loc)
            }

            throw new JsonnetError("An unknown error occurred while compiling Jsonnet", null)
        } else {
            return result[0]
        }
    }

    private getTypeOfAst(node): nodeType {
        // @ts-ignore
        return node.__proto__.constructor.string;
    }

    findRootNode(node: AST): AST | null {
        let nodeType = this.getTypeOfAst(node);
        if (nodeType == '*ast.Local') {
            // @ts-ignore
            return this.findRootNode(node.Body)
        }

        if (nodeType === '*ast.Array'
            || nodeType === '*ast.DesugaredObject'
            || nodeType === '*ast.LiteralNull'
            || nodeType === '*ast.LiteralNumber'
            || nodeType === '*ast.LiteralString'
            || nodeType === '*ast.LiteralBoolean') {
            return node
        }

        return null
    }

    findNodeFromJsonPath = function (rootNode: AST, path: Array<string | number>, currentIndex: number = 0): AST | null {
        if (path.length == currentIndex) {
            return rootNode
        }
        let nodeType = this.getTypeOfAst(rootNode);
        let currentPath = path[currentIndex];

        if (typeof (currentPath) === 'number') {
            if (nodeType !== '*ast.Array') {
                return rootNode
            }

            // @ts-ignore
            let $array = rootNode.Elements.$array;
        }

        if (nodeType != '*ast.DesugaredObject') {
            return rootNode
        }

        // @ts-ignore
        const objectField = rootNode.Fields.$array.find(field => field.Name.Value === currentPath);
        if (objectField != null) {
            return this.findNodeFromJsonPath(objectField.Body, path, currentIndex + 1)
        }

        return rootNode
    }

    createRangeFromLocation(locRange: Loc): jsonService.Range {
        // @ts-ignore
        return jsonService.Range.create(Math.max(locRange.Begin.Line - 1, 0), Math.max(locRange.Begin.Column - 1, 0), Math.max(locRange.End.Line - 1, 0), Math.max(locRange.End.Column, 0));
    }

    getLocationOfNode(ast: AST): jsonService.Range {
        // @ts-ignore
        let locRange = ast.NodeBase.LocRange;
        return this.createRangeFromLocation(locRange)
    }

}

export const extensions = ['.jsonnet', '.libsonnet']

class LruCache<T> {

    private values: Map<string, T> = new Map<string, T>();
    private maxEntries: number = 100;

    public get(key: string): T {
        const hasKey = this.values.has(key);
        let entry: T;
        if (hasKey) {
            // peek the entry, re-insert for LRU strategy
            entry = this.values.get(key);
            this.values.delete(key);
            this.values.set(key, entry);
        }

        return entry;
    }

    public put(key: string, value: T) {

        if (this.values.size >= this.maxEntries) {
            // least-recently used cache eviction strategy
            const keyToDelete = this.values.keys().next().value;

            this.values.delete(keyToDelete);
        }

        this.values.set(key, value);
    }

}
