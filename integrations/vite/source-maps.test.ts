import { candidate, css, fetchStyles, html, json, retryAssertion, test, ts } from '../utils'

function findLineAndColumn(content: string, needle: string): { line: number; column: number } {
  let index = content.indexOf(needle)
  if (index === -1) {
    throw new Error(`Could not find '${needle}' in generated CSS`)
  }

  // Convert absolute offset to 1-based line/0-based column as expected by source-map-js.
  let before = content.slice(0, index)
  let lines = before.split('\n')
  let line = lines.length
  let column = lines.at(-1)?.length ?? 0

  return { line, column }
}

test(
  `dev build`,
  {
    fs: {
      'package.json': json`
        {
          "type": "module",
          "dependencies": {
            "@tailwindcss/vite": "workspace:^",
            "tailwindcss": "workspace:^"
          },
          "devDependencies": {
            "lightningcss": "^1",
            "vite": "^7"
          }
        }
      `,
      'vite.config.ts': ts`
        import tailwindcss from '@tailwindcss/vite'
        import { defineConfig } from 'vite'

        export default defineConfig({
          plugins: [tailwindcss()],
          css: {
            devSourcemap: true,
          },
        })
      `,
      'index.html': html`
        <head>
          <link rel="stylesheet" href="./src/index.css" />
        </head>
        <body>
          <div class="flex">Hello, world!</div>
        </body>
      `,
      'src/index.css': css`
        @import 'tailwindcss/utilities';
        .from-root { color: red; }
        /*  */
      `,
    },
  },
  async ({ fs, spawn, expect, parseSourceMap }) => {
    // Source maps only work in development mode in Vite
    let process = await spawn('pnpm vite dev')
    await process.onStdout((m) => m.includes('ready in'))

    let url = ''
    await process.onStdout((m) => {
      let match = /Local:\s*(http.*)\//.exec(m)
      if (match) url = match[1]
      return Boolean(url)
    })

    let styles = await retryAssertion(async () => {
      let styles = await fetchStyles(url, '/index.html')

      // Wait until we have the right CSS
      expect(styles).toContain(candidate`flex`)

      return styles
    })

    // Make sure we can find a source map
    let map = parseSourceMap(styles)

    expect(map.at(1, 0)).toMatchObject({
      source: null,
      original: '(none)',
      generated: '/*! tailwi...',
    })

    expect(map.at(2, 0)).toMatchObject({
      source: expect.stringContaining('utilities.css'),
      original: '@tailwind...',
      generated: '.flex {...',
    })

    expect(map.at(3, 2)).toMatchObject({
      source: expect.stringContaining('utilities.css'),
      original: '@tailwind...',
      generated: 'display: f...',
    })

    expect(map.at(4, 0)).toMatchObject({
      source: null,
      original: '(none)',
      generated: '}...',
    })

    // Simulate an HMR update fetch (Vite appends `?t=...`) and verify the
    // sourcemap continues to map back to the original file (without `t=` in the
    // source URL).
    let cssPath = '/src/index.css'
    let initialCss = await (await fetch(`${url}${cssPath}?t=0`, { headers: { Accept: 'text/css' } }))
      .text()

    expect(initialCss).toContain('.from-root')

    let initialMap = parseSourceMap(initialCss)
    let initialPos = findLineAndColumn(initialCss, '.from-root')
    let initialMapping = initialMap.at(initialPos.line, initialPos.column)
    expect(initialMapping.source).toEqual(expect.stringContaining('src/index.css'))
    expect(initialMapping.source).not.toEqual(expect.stringContaining('t='))

    // Update the root file and fetch again with a new timestamp.
    await fs.write(
      'src/index.css',
      css`
        @import 'tailwindcss/utilities';
        .from-root { color: blue; }
        /*  */
      `,
    )

    let updatedCss = await retryAssertion(async () => {
      let updated = await (
        await fetch(`${url}${cssPath}?t=${Date.now()}`, { headers: { Accept: 'text/css' } })
      ).text()
      expect(updated).toContain('color: blue')
      return updated
    })

    let updatedMap = parseSourceMap(updatedCss)
    let updatedPos = findLineAndColumn(updatedCss, '.from-root')
    let updatedMapping = updatedMap.at(updatedPos.line, updatedPos.column)
    expect(updatedMapping.source).toEqual(expect.stringContaining('src/index.css'))
    expect(updatedMapping.source).not.toEqual(expect.stringContaining('t='))
  },
)
