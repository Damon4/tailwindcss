/** @type {import('next').NextConfig} */
const nextConfig = {
    sassOptions: {
        outputStyle: 'expanded',
        sourceMap: true,
    },
    turbopack: {},
    webpack: (config, options) => {
        function updateCssLoader(use) {
            if (!use || typeof use !== 'object') return
            if (typeof use.loader !== 'string') return
            if (!use.loader.includes('css-loader')) return

            if (use.options?.modules === true) {
                use.options.modules = {
                    localIdentName: '_[local]_[hash:5]',
                }
                return
            }

            if (use.options?.modules && typeof use.options.modules === 'object') {
                use.options.modules.localIdentName = '_[local]_[hash:5]'
            }
        }

        function walkRules(rules) {
            for (let rule of rules) {
                if (rule.oneOf) {
                    walkRules(rule.oneOf)
                }

                if (Array.isArray(rule.use)) {
                    for (let use of rule.use) {
                        if (typeof use === 'string') continue
                        updateCssLoader(use)
                    }
                } else if (rule.use && typeof rule.use === 'object') {
                    updateCssLoader(rule.use)
                }
            }
        }

        if (config.module?.rules) {
            walkRules(config.module.rules)
        }

        if (options.dev) {
            Object.defineProperty(config, 'devtool', {
                get() {
                    return 'source-map'
                },
                set() {
                    return 'source-map'
                },
            })
        }
        return config
    }
}

export default nextConfig
