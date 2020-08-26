'use strict';

import * as jsonService from "vscode-json-languageservice";
import {Go} from "./go";
import Library = monaco.languages.jsonnet.Library;
import ExtCodes = monaco.languages.jsonnet.ExtCodes;
import TlaVars = monaco.languages.jsonnet.TlaVars;

export interface FileMap {
    [path: string]: string
}

``

export class JsonnetError {
    location: jsonService.Range;
    message: string;

    constructor(message: string, location: jsonService.Range) {
        this.message = message;
        this.location = location
    }
}

export default class JsonnetVM {
    loadPromise = null

    constructor(compilerUrl) {
        const go = new Go();
        this.loadPromise = WebAssembly.instantiateStreaming(fetch(compilerUrl), go.importObject)
            .then(result => {
                go.run(result.instance);
                return null
            })
    }

    compile(path: string, files: FileMap, extCodes: ExtCodes, tlaVars: TlaVars, libraries: Library): Promise<string> {
        return this.loadPromise.then(() => {
            // @ts-ignore
            const result = self.compile(path, files, extCodes, tlaVars, libraries)
            // debugger

            if (result.error != null) {
                // @ts-ignore
                throw new JsonnetError(result.error, result.line)
            } else {
                return result.result
            }
        })
    }

    getLocationOfPaths(fileName: string, content: string, paths: Array<Array<string | number>>): Promise<Array<jsonService.Range>> {
        return this.loadPromise.then(() => {
            return paths.map(path => {
                // @ts-ignore
                return self.findLocationFromJsonPath(fileName, content, path);
            })
        })
    }

    getLocationOfPath(fileName: string, content: string, path: Array<string | number>): jsonService.Range {
        // @ts-ignore
        if (self.findLocationFromJsonPath == null) {
            throw Error("compiler is not loaded!")
        }
        // @ts-ignore
        let value = self.findLocationFromJsonPath(fileName, content, path);
        return value;
    }
}

