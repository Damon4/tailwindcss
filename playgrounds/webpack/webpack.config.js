const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')

const toFileUrl = (filePath) => `file://${filePath.replace(/\\/g, '/')}`

module.exports = (_env, argv) => {
    const isProd = argv.mode === 'production'
    const styleLoader = isProd ? MiniCssExtractPlugin.loader : 'style-loader'

    return {
        devtool: 'source-map',
        entry: path.resolve(__dirname, 'src/main.tsx'),
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: 'bundle.js',
            clean: true,
            sourceMapFilename: '[file].map',
            devtoolModuleFilenameTemplate: (info) => {
                if (!info.absoluteResourcePath) return info.resourcePath
                return toFileUrl(info.absoluteResourcePath)
            },
            devtoolFallbackModuleFilenameTemplate: (info) => {
                if (!info.absoluteResourcePath) return info.resourcePath
                return toFileUrl(info.absoluteResourcePath)
            },
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
                        {
                            loader: 'sass-loader',
                            options: {
                                implementation: require('sass-embedded'),
                            },
                        },
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
                    use: [
                        styleLoader,
                        'css-loader',
                        'postcss-loader',
                        {
                            loader: 'sass-loader',
                            options: {
                                implementation: require('sass-embedded'),
                            },
                        },
                    ],
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
                    new MiniCssExtractPlugin({
                        filename: '[name].css',
                    }),
                ]
                : []),
            new HtmlWebpackPlugin({
                template: path.resolve(__dirname, 'src/index.html'),
            }),
        ],
        devServer: {
            static: [
                'public'
            ],
            port: 5173,
            hot: true,
        },
    }
}
