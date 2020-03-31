/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import {WorkerManager} from './workerManager';
import {JSONWorker} from './jsonWorker';
import {LanguageServiceDefaultsImpl} from './monaco.contribution';
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
        const {languageId, modeConfiguration} = defaults;

        disposeAll(providers);

        if (modeConfiguration.diagnostics) {
            providers.push(new languageFeatures.DiagnosticsAdapter(languageId, worker, defaults));
        }

		if (modeConfiguration.documentFormattingEdits) {
			providers.push(monaco.languages.registerDocumentFormattingEditProvider(languageId, new languageFeatures.DocumentFormattingEditProvider(worker)));
		}

        providers.push(monaco.languages.registerHoverProvider(languageId, new languageFeatures.HoverAdapter(worker)));
    }

    registerProviders();

    disposables.push(monaco.languages.setLanguageConfiguration(defaults.languageId, richEditConfiguration));
    disposables.push(monaco.languages.setMonarchTokensProvider(defaults.languageId, monarchTokenizer));

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
    return {dispose: () => disposeAll(disposables)};
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
		{ open: '"', close: '"', notIn: ['string'] },
		{ open: '\'', close: '\'', notIn: ['string'] }
	]
};

import ILanguage = monaco.languages.IMonarchLanguage;

const monarchTokenizer = <ILanguage>{
	tokenPostfix: '.jsonnet',
	ignoreCase: false,
	brackets: [
		{ open: '[', close: ']', token: 'delimiter.square' },
		{ open: '{', close: '}', token: 'delimiter.object' }
	],

	// Set defaultToken to invalid to see what you do not tokenize yet
	keywords: [
		'self', 'super', 'import', 'importstr', 'local', 'tailstrict',
		'if', 'then', 'else', 'for', 'in', 'error', 'assert',
		'function',
	],

	literalKeywords: [
		'true', 'false', 'null'
	],

	operators: [
		'=', '>', '<',  '==', '<=', '>=', '!=',
		'&&', '||', '+', '-', '*', '/', '&', '|', '^', '%',
	],

	symbols:  /[=><!~?:&|+\-*\/\^%]+/,
	escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

	tokenizer: {
		root: [
			[/[a-zA-Z_][0-9A-Za-z_]*\s*\+?\:(:|::)?/, 'variable.name' ],  // to show props names nicely

			[/[a-zA-Z_.0-9]+\([^\)]*\)(\.[^\)]*\))?/, 'constant'], // function calls

			// identifiers and keywords
			[/[a-z_$][\w$]*/, { cases: { '@literalKeywords': 'keyword',
					'@keywords': 'keyword',
					'@default': 'identifier' } }],

			// whitespace
			{ include: '@whitespace' },

			// delimiters and operators
			[/[{}()\[\]]/, '@brackets'],
			[/[<>](?!@symbols)/, '@brackets'],
			[/@symbols/, { cases: { '@operators': 'operator',
					'@default'  : '' } } ],

			// numbers
			[/\d*\.\d+([eE][\-+]?\d+)?/, 'number.float'],
			[/0[xX][0-9a-fA-F]+/, 'number.hex'],
			[/\d+/, 'number'],

			// delimiter: after number because of .\d floats
			[/[;,.]/, 'delimiter'],

			// strings
			[/"([^"\\]|\\.)*$/, 'string.invalid' ],  // non-teminated string
			[/"([^'\\]|\\.)*$/, 'string.invalid' ],  // non-teminated string
			[/"/,  { token: 'string.quote', bracket: '@open', next: '@doubleQuotedString' } ],
			[/'/,  { token: 'string.quote', bracket: '@open', next: '@singleQuotedString' } ],
			[/\|\|\|/, '@tripleQuotedString'],

			// characters
			[/'[^\\']'/, 'string'],
			[/(')(@escapes)(')/, ['string','string.escape','string']],
			[/'/, 'string.invalid']
		],

		comment: [
			[/[^\/*]+/, 'comment' ],
			[/\/\*/,    'comment', '@push' ],    // nested comment
			["\\*/",    'comment', '@pop'  ],
			[/[\/*]/,   'comment' ]
		],

		tripleQuotedString: [
			[/[^|||]+$/, 'string' ],
			[/\|\|\|/,    'string', '@pop'  ],
		],

		doubleQuotedString: [
			[/[^\\"]+/,  'string'],
			[/@escapes/, 'string.escape'],
			[/\\./,      'string.escape.invalid'],
			[/"/,        { token: 'string.quote', bracket: '@close', next: '@pop' } ]
		],

		singleQuotedString: [
			[/[^\\']+/,  'string'],
			[/@escapes/, 'string.escape'],
			[/\\./,      'string.escape.invalid'],
			[/'/,        { token: 'string.quote', bracket: '@close', next: '@pop' } ]
		],

		whitespace: [
			[/[ \t\r\n]+/, 'white'],
			[/\/\*/,       'comment', '@comment' ],
			[/\/\/.*$/,    'comment'],
			[/\|\|\|$/,   'string', '@tripleQuotedString' ],
		],
	},
};

