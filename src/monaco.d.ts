/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module monaco.languages.jsonnet {

	export interface DiagnosticsOptions {
		/**
		 * If set, the validator will be enabled and perform syntax validation as well as schema based validation.
		 */
		readonly validate?: boolean;
		/**
		 * A list of known schemas and/or associations of schemas to file names.
		 */
		readonly schemas?: {
			/**
			 * The URI of the schema, which is also the identifier of the schema.
			 */
			readonly uri: string;
			/**
			 * A list of file names that are associated to the schema. The '*' wildcard can be used. For example '*.schema.json', 'package.json'
			 */
			readonly fileMatch?: string[];
			/**
			 * The schema for the given URI.
			 */
			readonly schema?: any;
		}[];
		/**
		 *  If set, the schema service would load schema content on-demand with 'fetch' if available
		 */
		readonly enableSchemaRequest?: boolean;
		readonly extVars: Map<String, any>;
		readonly tlaVars: Map<String, any>;
		readonly libraries: Library;
		readonly compilerUrl: string;
	}

	export interface ModeConfiguration {
		/**
		 * Defines whether the built-in documentFormattingEdit provider is enabled.
		 */
		readonly documentFormattingEdits?: boolean;

		/**
		 * Defines whether the built-in documentRangeFormattingEdit provider is enabled.
		 */
		readonly documentRangeFormattingEdits?: boolean;

		/**
		 * Defines whether the built-in completionItemProvider is enabled.
		 */
		readonly completionItems?: boolean;

		/**
		 * Defines whether the built-in hoverProvider is enabled.
		 */
		readonly hovers?: boolean;

		/**
		 * Defines whether the built-in documentSymbolProvider is enabled.
		 */
		readonly documentSymbols?: boolean;

		/**
		 * Defines whether the built-in foldingRange provider is enabled.
		 */
		readonly foldingRanges?: boolean;

		/**
		 * Defines whether the built-in diagnostic provider is enabled.
		 */
		readonly diagnostics?: boolean;

		/**
		 * Defines whether the built-in selection range provider is enabled.
		 */
		readonly selectionRanges?: boolean;

	}

	interface Library {
		[path: string]: string
	}

	export interface ExtCodes {
		[name: string]: string
	}

	export interface TlaVars {
		[name: string]: string
	}

	export interface LanguageServiceDefaults {
		readonly onDidChange: IEvent<LanguageServiceDefaults>;
		readonly diagnosticsOptions: DiagnosticsOptions;
		readonly modeConfiguration: ModeConfiguration;
		setDiagnosticsOptions(options: DiagnosticsOptions): void;
		setModeConfiguration(modeConfiguration: ModeConfiguration): void;
	}

	export var jsonnetDefaults: LanguageServiceDefaults;

	export const getWorker: () => Promise<(...uris: Uri[]) => Promise<JsonnetWorker>>;

	export interface JsonnetWorker {
		getJsonPaths(uri : Uri, ...jsonPath: Array<string | number>[]) : Promise<Array<monaco.IRange>>;
		compile(uri : Uri) : Promise<string>
	}
}
