'use strict';

import * as jsonService from "vscode-json-languageservice";
import {Go} from "./go";
import Library = monaco.languages.jsonnet.Library;
import ExtCodes = monaco.languages.jsonnet.ExtCodes;
import TlaVars = monaco.languages.jsonnet.TlaVars;

export interface FileMap {
    [path: string]: string
}

export class JsonnetError {
    location: jsonService.Range;
    message: string;

    constructor(message: string, location: jsonService.Range) {
        this.message = message;
        this.location = location
    }
}

if (!WebAssembly.instantiateStreaming) { // polyfill
    WebAssembly.instantiateStreaming = async (resp, importObject) => {
        const source = await (await resp).arrayBuffer();
        return await WebAssembly.instantiate(source, importObject);
    };
}

export default class JsonnetVM {
    loadPromise = null
    compilerCache: LruCache

    constructor(compilerUrl) {
        this.compilerCache = new LruCache()
        const go = new Go();

        this.loadPromise = WebAssembly.instantiateStreaming(fetch(compilerUrl), go.importObject)
            .then(result => {
                go.run(result.instance);
                return null
            }).catch(e => {
                console.error("Unable to load Jsonnet compiler", e)
            })
    }

    format(file: string, content: string): Promise<string> {
        return this.loadPromise.then(() => {
            // @ts-ignore
            return self.format(file, content);
        })
    }

    compile(path: string, files: FileMap, extCodes: ExtCodes, tlaVars: TlaVars, libraries: Library): Promise<string> {
        let content = files[path];
        const existingCache = this.compilerCache.get(path, content)
        if (existingCache != null) {
            return Promise.resolve(existingCache)
        }

        return this.loadPromise.then(() => {
            // console.time(`compiling ${path}`)

            // @ts-ignore
            const result = self.compile(path, files, extCodes, tlaVars, libraries)

            // console.timeEnd(`compiling ${path}`)

            if (result.error != null) {
                // @ts-ignore
                throw new JsonnetError(result.error, result.line)
            } else {
                this.compilerCache.put(path, files[path], result.result)
                return result.result
            }
        })
    }

    getLocationOfPaths(fileName: string, content: string, paths: Array<Array<string | number>>): Promise<Array<jsonService.Range>> {
        return this.loadPromise.then(() => {
            return paths.map(path => {
                // @ts-ignore
                return self.findLocationFromJsonPath(fileName, content, path, true);
            })
        })
    }

    getLocationOfPath(fileName: string, content: string, path: Array<string | number>, failSafe: boolean): jsonService.Range {
        // @ts-ignore
        if (self.findLocationFromJsonPath == null) {
            throw Error("compiler is not loaded!")
        }
        // @ts-ignore
        return self.findLocationFromJsonPath(fileName, content, path, failSafe);
    }

    getJsonPathFromLocation(content: string, line: number, character: number): NodeLocation {
        // @ts-ignore
        if (self.getJsonPathFromLocation == null) {
            throw Error("compiler is not loaded!")
        }
        // @ts-ignore
        let value = self.getJsonPathFromLocation("test.jsonnet", content, line + 1, character + 1);
        return value;
    }

    getLastOutput(path: string): KeyValuePair {
        return this.compilerCache.values.get(path);
    }
}

interface NodeLocation {
    type: string;
    location: jsonService.Range;
    path: Array<string | number>
}

interface KeyValuePair {
    jsonnet: string;
    json: string;
}

class LruCache {
    public values = new Map<string, KeyValuePair>();
    private maxEntries: number = 1000;

    public get(path: string, content: string): string {
        // the library and extcode will be same as the configuration change causes the worker to be restarted.
        const value = this.values.get(path);
        if (value && value.jsonnet == content) {
            return value.json
        }
    }

    public put(filename: string, jsonnet: string, json: string) {
        if (this.values.size >= this.maxEntries) {
            // least-recently used cache eviction strategy
            const keyToDelete = this.values.keys().next().value;

            this.values.delete(keyToDelete);
        }

        this.values.set(filename, {jsonnet, json});
    }
}

