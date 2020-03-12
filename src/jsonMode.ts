/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { WorkerManager } from './workerManager';
import { JSONWorker } from './jsonWorker';
import { LanguageServiceDefaultsImpl } from './monaco.contribution';
import * as languageFeatures from './languageFeatures';

import Uri = monaco.Uri;
import IDisposable = monaco.IDisposable;

export function setupMode(defaults: LanguageServiceDefaultsImpl): IDisposable {

	const disposables: IDisposable[] = [];
	const providers: IDisposable[] = [];

	const client = new WorkerManager(defaults);
	disposables.push(client);

	const worker: languageFeatures.WorkerAccessor = (...uris: Uri[]): Promise<JSONWorker> => {
		return client.getLanguageServiceWorker(...uris);
	};


	function registerProviders(): void {
		const { languageId, modeConfiguration } = defaults;

		disposeAll(providers);

		if (modeConfiguration.diagnostics) {
			providers.push(new languageFeatures.DiagnosticsAdapter(languageId, worker, defaults));
		}

		providers.push(monaco.languages.registerHoverProvider(languageId, new languageFeatures.HoverAdapter(worker)));
	}

	registerProviders();

	disposables.push(monaco.languages.setLanguageConfiguration(defaults.languageId, richEditConfiguration));

	let modeConfiguration = defaults.modeConfiguration;
	defaults.onDidChange((newDefaults) => {
		if (newDefaults.modeConfiguration !== modeConfiguration) {
			modeConfiguration = newDefaults.modeConfiguration;
			registerProviders();
		}
	});

	disposables.push(asDisposable(providers));

	return asDisposable(disposables);
}

function asDisposable(disposables: IDisposable[]): IDisposable {
	return { dispose: () => disposeAll(disposables) };
}

function disposeAll(disposables: IDisposable[]) {
	while (disposables.length) {
		disposables.pop().dispose();
	}
}

const richEditConfiguration: monaco.languages.LanguageConfiguration = {
	wordPattern: /(-?\d*\.\d\w*)|([^\[\{\]\}\:\"\,\s]+)/g,

	comments: {
		lineComment: '//',
		blockComment: ['/*', '*/']
	},

	brackets: [
		['{', '}'],
		['[', ']']
	],

	autoClosingPairs: [
		{ open: '{', close: '}', notIn: ['string'] },
		{ open: '[', close: ']', notIn: ['string'] },
		{ open: '"', close: '"', notIn: ['string'] }
	]
};

