/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as mode from './jsonnetMode';

import Emitter = monaco.Emitter;
import IEvent = monaco.IEvent;
import JsonnetWorker = monaco.languages.jsonnet.JsonnetWorker;

export class LanguageServiceDefaultsImpl implements monaco.languages.jsonnet.LanguageServiceDefaults {

	private _onDidChange = new Emitter<monaco.languages.jsonnet.LanguageServiceDefaults>();
	private _diagnosticsOptions: monaco.languages.jsonnet.DiagnosticsOptions;
	private _modeConfiguration: monaco.languages.jsonnet.ModeConfiguration;
	private _languageId: string;

	constructor(languageId: string, diagnosticsOptions: monaco.languages.jsonnet.DiagnosticsOptions, modeConfiguration: monaco.languages.jsonnet.ModeConfiguration) {
		this._languageId = languageId;
		this.setDiagnosticsOptions(diagnosticsOptions);
		this.setModeConfiguration(modeConfiguration);
	}

	get onDidChange(): IEvent<monaco.languages.jsonnet.LanguageServiceDefaults> {
		return this._onDidChange.event;
	}

	get languageId(): string {
		return this._languageId;
	}

	get modeConfiguration(): monaco.languages.jsonnet.ModeConfiguration {
		return this._modeConfiguration;
	}

	get diagnosticsOptions(): monaco.languages.jsonnet.DiagnosticsOptions {
		return this._diagnosticsOptions;
	}

	setDiagnosticsOptions(options: monaco.languages.jsonnet.DiagnosticsOptions): void {
		this._diagnosticsOptions = options || Object.create(null);
		this._onDidChange.fire(this);
	}

	setModeConfiguration(modeConfiguration: monaco.languages.jsonnet.ModeConfiguration): void {
		this._modeConfiguration = modeConfiguration || Object.create(null);
		this._onDidChange.fire(this);
	};
}

const diagnosticDefault: Required<monaco.languages.jsonnet.DiagnosticsOptions> = {
	validate: true,
	libraries: {},
	schemas: [],
	enableSchemaRequest: false,
	extVars: new Map(),
	tlaVars: new Map(),
	compilerUrl: null,
};

const modeConfigurationDefault: Required<monaco.languages.jsonnet.ModeConfiguration> = {
	documentFormattingEdits: true,
	documentRangeFormattingEdits: true,
	completionItems: true,
	hovers: true,
	documentSymbols: false,
	foldingRanges: false,
	diagnostics: true,
	selectionRanges: false
}

const jsonnetDefaults = new LanguageServiceDefaultsImpl('jsonnet', diagnosticDefault, modeConfigurationDefault);

// Export API
function createAPI(): typeof monaco.languages.jsonnet {
	return {
		jsonnetDefaults: jsonnetDefaults,
		getWorker: getWorker
	}
}
monaco.languages.jsonnet = createAPI();

// --- Registration to monaco editor ---

function getMode(): Promise<typeof mode> {
	return import('./jsonnetMode');
}

monaco.languages.register({
	id: 'jsonnet',
	extensions: ['.jsonnet', '.libsonnet'],
	mimetypes: ['application/jsonnet'],
});

monaco.languages.onLanguage('jsonnet', () => {
	getMode().then(mode => mode.setupMode(jsonnetDefaults));
});

function getWorker(): Promise<(...uris: monaco.Uri[]) => Promise<JsonnetWorker>> {
	return getMode().then(mode => mode.getWorker());
}
