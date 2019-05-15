module.exports = {
	mode: 'none',
	entry: __dirname + '/src/indb.js',
	output: {
		path: __dirname + '/dist',
		filename: 'indb.js',
		library: 'indb',
		libraryTarget: 'umd',
		globalObject: `typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : this`,
	},
	module: {
		rules: [
			{
				test: /\.js$/,
				use: 'babel-loader',
			},
		],
	},
	optimization: {
		minimize: false,
		usedExports: true,
		sideEffects: true,
	},
	devtool: 'source-map',
}
