const path = require('node:path')
const { rspack } = require('@rspack/core')

/** @type {rspack.Configuration} */
module.exports = (_env, argv) => {
    const isProd = argv.mode === 'production'
    const styleLoader = isProd ? rspack.CssExtractRspackPlugin.loader : 'style-loader'

    return {
        devtool: 'source-map',
        entry: path.resolve(__dirname, 'src/main.tsx'),
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: 'bundle.js',
            clean: true,
        },
        resolve: {
            extensions: ['.ts', '.tsx', '.js'],
        },
        module: {
            rules: [
                {
                    test: /\.module\.css$/i,
                    use: [
                        styleLoader,
                        {
                            loader: 'css-loader',
                            options: {
                                modules: {
                                    localIdentName: '_[local]_[hash:5]',
                                },
                            },
                        },
                        'postcss-loader',
                    ],
                },
                {
                    test: /\.module\.scss$/i,
                    use: [
                        styleLoader,
                        {
                            loader: 'css-loader',
                            options: {
                                modules: {
                                    localIdentName: '_[local]_[hash:5]',
                                },
                            },
                        },
                        'postcss-loader',
                        'sass-loader',
                    ],
                },
                {
                    test: /\.css$/i,
                    exclude: /\.module\.css$/i,
                    use: [styleLoader, 'css-loader', 'postcss-loader'],
                },
                {
                    test: /\.scss$/i,
                    exclude: /\.module\.scss$/i,
                    use: [styleLoader, 'css-loader', 'postcss-loader', 'sass-loader'],
                },
                {
                    test: /\.(ts|tsx)$/,
                    exclude: /node_modules/,
                    use: {
                        loader: 'swc-loader',
                        options: {
                            jsc: {
                                parser: {
                                    syntax: 'typescript',
                                    tsx: true,
                                },
                                transform: {
                                    react: {
                                        runtime: 'automatic',
                                        development: process.env.NODE_ENV !== 'production',
                                    },
                                },
                            },
                        },
                    },
                },
            ],
        },
        plugins: [
            ...(isProd
                ? [
                    new rspack.CssExtractRspackPlugin({
                        filename: '[name].css',
                    }),
                ]
                : []),
            new rspack.HtmlRspackPlugin({
                template: path.resolve(__dirname, 'src/index.html'),
            }),
        ],
        devServer: {
            static: ['public'],
            port: 5173,
            hot: false,
        },
    }
}
