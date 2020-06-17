# Monaco Jsonnet

Jsonnet language plugin for the Monaco Editor. It provides the following features when editing Jsonnet files:
* Validation based on JSON schemas or by looking at similar objects in the same file
* Validation: Syntax errors and schema validation
* Syntax highlighting
* Color decorators for all properties matching a schema containing `format: "color-hex"'` (non-standard schema extension)

#TODO
* Hovers, based on JSON schemas
* Formatting
* Document Symbols
* Code completion

Schemas can be provided by configuration. See [here](https://github.com/Microsoft/monaco-json/blob/master/src/monaco.d.ts)
for the API that the JSON plugin offers to configure the JSON language support.

Internally the Jsonnet plugin uses the [vscode-jsonnet-languageservice](https://github.com/rakam-io/vscode-jsonnet-languageservice)
node module, providing the implementation of the features listed above.

## Development

* `git clone https://github.com/Microsoft/monaco-jsonnet`
* `npm install .`
* compile with `npm run compile`
* watch with `npm run watch`
* `npm run prepublishOnly`
* open `$/monaco-jsonnet/test/index.html` in your favorite browser.

## License
[MIT](https://github.com/rakam-io/monaco-jsonnet/blob/master/LICENSE.md)
