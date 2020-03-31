'use strict';

import jsonnetPackage from 'gopher-jsonnet'
import {errors} from 'gopher-jsonnet'
import * as jsonService from "vscode-json-languageservice";
import normalize from './path-normalize'

type FileMap = Map<string, string>;
type AST = object;

export class JsonnetError {
    ast: object;
    message: string;

    constructor(message: string, ast: AST | null) {
        debugger
        this.message = message;
        this.ast = ast
    }
}

type Error = { message: string, loc: object };
type Failable<R, E> = { isError: true; error: E; } | { isError: false; value: R; }

type nodeType = '*ast.Array' | '*ast.Binary' | '*ast.Unary' | '*ast.Conditional'
    | '*ast.DesugaredObject' | '*ast.Error' | '*ast.Index' | '*ast.Import' | '*ast.ImportStr'
    | '*ast.LiteralBoolean' | '*ast.LiteralNull' | '*ast.LiteralNumber' | '*ast.LiteralString' | '*ast.Local'
    | '*ast.Self' | '*ast.Var' | '*ast.SuperIndex' | '*ast.InSuper' | '*ast.Function' | '*ast.Apply'

export default class JsonnetVM {
    private vm: any;
    // I could not find a way to create the error instance using Gopherjs API so we create a dummy error
    private dummyError: any;

    constructor() {
        this.vm = jsonnetPackage.MakeVM()
    }

    get lazyDummyError() {
        if(this.dummyError == null) {
            this.dummyError = jsonnetPackage.SnippetToAST("test", "1")[1];
        }
        return this.dummyError
    }

    parse(path: string, files: FileMap): AST {
        let content = files.get(path);
        let ast = jsonnetPackage.SnippetToAST(path, content)
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

    private getDirectoryFromPath(path : string) : string {
        return path.substring(0, path.lastIndexOf("/")+1)
    }

    compile(path: string, files: FileMap, extCodes: Map<string, string>, ast: AST) {
        Object.keys(extCodes).forEach(key => {
            this.vm.ExtCode(key, extCodes[key])
        })

        this.vm.Importer({
            Import: (importedFrom, importedPath) => {
                let target = this.getDirectoryFromPath(normalize(importedFrom)) + normalize(importedPath);
                let content = files.get(target);
                if(content != null) {
                    return [jsonnetPackage.MakeContents(content), importedPath, this.lazyDummyError]
                } else {
                    return [jsonnetPackage.MakeContents(""), importedPath, errors.New(`Error compiled file ${importedFrom}: Imported path ${target} not found`)]
                }
            }
        })

        let result = this.vm.Evaluate(ast);
        if (result[0] === '') {
            let errorType = result[1].constructor.string;
            if (errorType === '*errors.errorString') {
                throw new JsonnetError(result[1].s, null)
            }

            if(errorType === 'jsonnet.RuntimeError') {
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
        let nodeType = this.getTypeOfAst(rootNode);
        let currentPath = path[currentIndex];

        if (typeof (currentPath) === 'number') {
            if (nodeType !== '*ast.Array') {
                return rootNode
            }

            // @ts-ignore
            let $array = rootNode.Elements.$array;
            debugger
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

    getLocationOfNode(ast : AST) : jsonService.Range {
        // @ts-ignore
        let locRange = ast.NodeBase.LocRange;
        return jsonService.Range.create(locRange.Begin.Line - 1, locRange.Begin.Column - 1, locRange.End.Line - 1, locRange.End.Column);
    }
}
