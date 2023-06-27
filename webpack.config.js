module.exports = {
	mode: 'none',
	entry: __dirname + '/es/index.js',
	output: {
		path: __dirname + '/dist',
		filename: 'index.js',
		library: 'index',
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
		minimize: true,
		usedExports: true,
		sideEffects: true,
	},
	devtool: 'source-map',
}
