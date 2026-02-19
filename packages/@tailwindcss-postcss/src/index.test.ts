import dedent from 'dedent'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'path'
import postcss from 'postcss'
import { SourceMapConsumer, type RawSourceMap } from 'source-map-js'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import tailwindcss from './index'

// We give this file path to PostCSS for processing.
// This file doesn't exist, but the path is used to resolve imports.
// We place it in packages/ because Vitest runs in the monorepo root,
// and packages/tailwindcss must be a sub-folder for
// @import 'tailwindcss' to work.
function inputCssFilePath() {
  // Including the current test name to ensure that the cache is invalidated per
  // test otherwise the cache will be used across tests.
  return `${__dirname}/fixtures/example-project/input.css?test=${expect.getState().currentTestName}`
}

const css = dedent

function findLineAndColumn(content: string, needle: string): { line: number; column: number } {
  let index = content.indexOf(needle)
  if (index === -1) {
    throw new Error(`Could not find '${needle}' in generated CSS`)
  }

  // Source maps use 1-based lines and 0-based columns.
  let before = content.slice(0, index)
  let lines = before.split('\n')
  let line = lines.length
  let column = lines.at(-1)?.length ?? 0
  return { line, column }
}

async function expectMapsBackTo(
  result: postcss.Result,
  expectedSource: string,
) {
  expect(result.map).toBeTruthy()

  let raw = result.map!.toJSON() as RawSourceMap
  let sources = (raw.sources ?? []).map((s) => s.replaceAll('\\', '/'))
  let normalizedExpected = expectedSource.replaceAll('\\', '/')

  let isUrlLike = /^[a-zA-Z][a-zA-Z+.-]*:\/\//.test(normalizedExpected)
  let expectedBasename = normalizedExpected.split('/').at(-1) ?? normalizedExpected

  let matchesExpected = (s: string | null | undefined) => {
    if (!s) return false
    let normalized = s.replaceAll('\\', '/')

    if (isUrlLike) {
      return normalized === normalizedExpected
    }

    // For filesystem paths, bundlers may emit relative sources.
    return (
      normalized === normalizedExpected ||
      normalized.endsWith(normalizedExpected) ||
      normalized.endsWith('/' + expectedBasename) ||
      normalized === expectedBasename
    )
  }

  expect(sources.some((s) => matchesExpected(s))).toBe(true)

  // Verify at least one concrete mapping points back to the expected source.
  let pos = findLineAndColumn(result.css, '.hmt-test')
  let consumer = await new SourceMapConsumer(raw)
  try {
    let original = consumer.originalPositionFor({ line: pos.line, column: pos.column })
    expect(matchesExpected(original.source)).toBe(true)
  } finally {
    ;(consumer as any).destroy?.()
  }
}

test("`@import 'tailwindcss'` is replaced with the generated CSS", async () => {
  let processor = postcss([
    tailwindcss({ base: `${__dirname}/fixtures/example-project`, optimize: { minify: false } }),
  ])

  let result = await processor.process(`@import 'tailwindcss'`, { from: inputCssFilePath() })

  expect(result.css.trim()).toMatchSnapshot()

  // Check for dependency messages
  expect(result.messages).toContainEqual({
    type: 'dependency',
    file: expect.stringMatching(/index.html$/g),
    parent: expect.any(String),
    plugin: expect.any(String),
  })
  expect(result.messages).toContainEqual({
    type: 'dependency',
    file: expect.stringMatching(/index.js$/g),
    parent: expect.any(String),
    plugin: expect.any(String),
  })
  expect(result.messages).toContainEqual({
    type: 'dir-dependency',
    dir: expect.stringMatching(/example-project[\/|\\]src$/g),
    glob: expect.stringMatching(/^\*\*\/\*/g),
    parent: expect.any(String),
    plugin: expect.any(String),
  })
})

test('source maps do not include query params in sources (HMR stable)', async () => {
  let processor = postcss([
    tailwindcss({ base: `${__dirname}/fixtures/example-project`, optimize: false }),
  ])

  // Simulate an HMR cache-busting query param.
  let fromWithQuery = `${__dirname}/fixtures/example-project/input.css?t=${Date.now()}`

  let result = await processor.process(
    css`
      @import 'tailwindcss/utilities';

      .hmt-test {
        @apply underline;
      }
    `,
    {
      from: fromWithQuery,
      map: { inline: false, annotation: false },
    },
  )

  await expectMapsBackTo(result, `${__dirname}/fixtures/example-project/input.css`)

  // Ensure the cache-busting param is stripped from the input source.
  let json = result.map!.toJSON() as RawSourceMap
  let sources = (json.sources ?? []).map((s) => s.replaceAll('\\', '/'))
  expect(sources.some((s) => s.includes('t='))).toBe(false)
})

test('source maps map back to input file (default, no query)', async () => {
  let processor = postcss([
    tailwindcss({ base: `${__dirname}/fixtures/example-project`, optimize: false }),
  ])

  let from = `${__dirname}/fixtures/example-project/input.css`

  let result = await processor.process(
    css`
      @import 'tailwindcss/utilities';

      .hmt-test {
        @apply underline;
      }
    `,
    {
      from,
      map: { inline: false, annotation: false },
    },
  )

  await expectMapsBackTo(result, from)
})

test('source maps preserve webpack:// identity (strip only t=)', async () => {
  let processor = postcss([
    tailwindcss({ base: `${__dirname}/fixtures/example-project`, optimize: false }),
  ])

  let from = `webpack://./src/styles/config.css?t=${Date.now()}`
  let expected = `webpack://./src/styles/config.css`

  let result = await processor.process(
    css`
      @import 'tailwindcss/utilities';

      .hmt-test {
        @apply underline;
      }
    `,
    {
      from,
      map: { inline: false, annotation: false },
    },
  )

  await expectMapsBackTo(result, expected)
})

test('output is optimized by Lightning CSS', async () => {
  let processor = postcss([
    tailwindcss({ base: `${__dirname}/fixtures/example-project`, optimize: { minify: false } }),
  ])

  let result = await processor.process(
    css`
      @layer utilities {
        .foo {
          @apply text-[black];
        }
      }

      @layer utilities {
        .bar {
          color: red;
        }
      }
    `,
    { from: inputCssFilePath() },
  )

  expect(result.css.trim()).toMatchInlineSnapshot(`
    "@layer utilities {
      .foo {
        color: #000;
      }

      .bar {
        color: red;
      }
    }"
  `)
})

test('@apply can be used without emitting the theme in the CSS file', async () => {
  let processor = postcss([
    tailwindcss({ base: `${__dirname}/fixtures/example-project`, optimize: { minify: false } }),
  ])

  let result = await processor.process(
    css`
      @reference 'tailwindcss/theme.css';
      .foo {
        @apply text-red-500;
      }
    `,
    { from: inputCssFilePath() },
  )

  expect(result.css.trim()).toMatchInlineSnapshot(`
    ".foo {
      color: var(--color-red-500, oklch(63.7% .237 25.331));
    }"
  `)
})

describe('processing without specifying a base path', () => {
  let filepath: string
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tw-postcss'))
    await mkdir(dir, { recursive: true })
    filepath = path.join(dir, 'my-test-file.html')
    await writeFile(filepath, `<div class="md:[&:hover]:content-['testing_default_base_path']">`)
  })
  afterEach(() => unlink(filepath))

  test('the current working directory is used by default', async () => {
    const spy = vi.spyOn(process, 'cwd')
    spy.mockReturnValue(dir)

    let processor = postcss([tailwindcss({ optimize: { minify: false } })])

    let result = await processor.process(`@import "tailwindcss"`, { from: inputCssFilePath() })

    expect(result.css).toContain(
      ".md\\:\\[\\&\\:hover\\]\\:content-\\[\\'testing_default_base_path\\'\\]",
    )

    expect(result.messages).toContainEqual({
      type: 'dependency',
      file: expect.stringMatching(/my-test-file.html$/g),
      parent: expect.any(String),
      plugin: expect.any(String),
    })
  })
})

describe('plugins', () => {
  test('local CJS plugin', async () => {
    let processor = postcss([
      tailwindcss({ base: `${__dirname}/fixtures/example-project`, optimize: { minify: false } }),
    ])

    let result = await processor.process(
      css`
        @import 'tailwindcss/utilities';
        @plugin './plugin.js';
      `,
      { from: inputCssFilePath() },
    )

    expect(result.css.trim()).toMatchInlineSnapshot(`
      ".underline {
        text-decoration-line: underline;
      }

      @media (inverted-colors: inverted) {
        .inverted\\:flex {
          display: flex;
        }
      }

      .hocus\\:underline:focus, .hocus\\:underline:hover {
        text-decoration-line: underline;
      }"
    `)
  })

  test('local CJS plugin from `@import`-ed file', async () => {
    let processor = postcss([
      tailwindcss({ base: `${__dirname}/fixtures/example-project`, optimize: { minify: false } }),
    ])

    let result = await processor.process(
      css`
        @import 'tailwindcss/utilities';
        @import '../example-project/src/relative-import.css';
      `,
      { from: `${__dirname}/fixtures/another-project/input.css` },
    )

    expect(result.css.trim()).toMatchInlineSnapshot(`
      ".underline {
        text-decoration-line: underline;
      }

      @media (inverted-colors: inverted) {
        .inverted\\:flex {
          display: flex;
        }
      }

      .hocus\\:underline:focus, .hocus\\:underline:hover {
        text-decoration-line: underline;
      }"
    `)
  })

  test('published CJS plugin', async () => {
    let processor = postcss([
      tailwindcss({ base: `${__dirname}/fixtures/example-project`, optimize: { minify: false } }),
    ])

    let result = await processor.process(
      css`
        @import 'tailwindcss/utilities';
        @plugin 'internal-example-plugin';
      `,
      { from: inputCssFilePath() },
    )

    expect(result.css.trim()).toMatchInlineSnapshot(`
      ".underline {
        text-decoration-line: underline;
      }

      @media (inverted-colors: inverted) {
        .inverted\\:flex {
          display: flex;
        }
      }

      .hocus\\:underline:focus, .hocus\\:underline:hover {
        text-decoration-line: underline;
      }"
    `)
  })
})

test('bail early when Tailwind is not used', async () => {
  let processor = postcss([
    tailwindcss({ base: `${__dirname}/fixtures/example-project`, optimize: { minify: false } }),
  ])

  let result = await processor.process(
    css`
      .custom-css {
        color: red;
      }
    `,
    { from: inputCssFilePath() },
  )

  // `fixtures/example-project` includes an `underline` candidate. But since we
  // didn't use `@tailwind utilities` we didn't scan for utilities.
  expect(result.css).not.toContain('.underline {')

  expect(result.css.trim()).toMatchInlineSnapshot(`
    ".custom-css {
      color: red;
    }"
  `)
})

test('handle CSS when only using a `@reference` (we should not bail early)', async () => {
  let processor = postcss([
    tailwindcss({ base: `${__dirname}/fixtures/example-project`, optimize: { minify: false } }),
  ])

  let result = await processor.process(
    css`
      @reference "tailwindcss/theme.css";

      .foo {
        @variant md {
          bar: baz;
        }
      }
    `,
    { from: inputCssFilePath() },
  )

  expect(result.css.trim()).toMatchInlineSnapshot(`
    "@media (min-width: 48rem) {
      .foo {
        bar: baz;
      }
    }"
  `)
})

test('handle CSS when using a `@variant` using variants that do not rely on the `@theme`', async () => {
  let processor = postcss([
    tailwindcss({ base: `${__dirname}/fixtures/example-project`, optimize: { minify: false } }),
  ])

  let result = await processor.process(
    css`
      .foo {
        @variant data-is-hoverable {
          bar: baz;
        }
      }
    `,
    { from: inputCssFilePath() },
  )

  expect(result.css.trim()).toMatchInlineSnapshot(`
    ".foo[data-is-hoverable] {
      bar: baz;
    }"
  `)
})

test('runs `Once` plugins in the right order', async () => {
  let before = ''
  let after = ''
  let processor = postcss([
    {
      postcssPlugin: 'before',
      Once(root) {
        before = root.toString()
      },
    },
    tailwindcss({ base: `${__dirname}/fixtures/example-project`, optimize: { minify: false } }),
    {
      postcssPlugin: 'after',
      Once(root) {
        after = root.toString()
      },
    },
  ])

  let result = await processor.process(
    css`
      @theme {
        --color-red-500: red;
      }
      .custom-css {
        color: theme(--color-red-500);
      }
    `,
    { from: inputCssFilePath() },
  )

  expect(result.css.trim()).toMatchInlineSnapshot(`
    ".custom-css {
      color: red;
    }"
  `)
  expect(before).toMatchInlineSnapshot(`
    "@theme {
      --color-red-500: red;
    }
    .custom-css {
      color: theme(--color-red-500);
    }"
  `)
  expect(after).toMatchInlineSnapshot(`
    ".custom-css {
      color: red;
    }"
  `)
})

describe('concurrent builds', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tw-postcss'))
    await writeFile(path.join(dir, 'index.html'), `<div class="underline"></div>`)
    await writeFile(
      path.join(dir, 'index.css'),
      css`
        @import './dependency.css';
      `,
    )
    await writeFile(
      path.join(dir, 'dependency.css'),
      css`
        @tailwind utilities;
      `,
    )
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  test('does experience a race-condition when calling the plugin two times for the same change', async () => {
    const spy = vi.spyOn(process, 'cwd')
    spy.mockReturnValue(dir)

    let from = path.join(dir, 'index.css')
    let input = (await readFile(path.join(dir, 'index.css'))).toString()

    let plugin = tailwindcss({ optimize: { minify: false } })

    async function run(input: string): Promise<string> {
      let ast = postcss.parse(input)
      for (let runner of (plugin as any).plugins) {
        if (runner.Once) {
          await runner.Once(ast, { postcss, result: { opts: { from }, messages: [] } })
        }
      }
      return ast.toString()
    }

    let result = await run(input)

    expect(result).toContain('.underline')

    // Ensure that the mtime is updated
    await new Promise((resolve) => setTimeout(resolve, 100))
    await writeFile(
      path.join(dir, 'dependency.css'),
      css`
        @tailwind utilities;
        .red {
          color: red;
        }
      `,
    )

    let promise1 = run(input)
    let promise2 = run(input)

    expect(await promise1).toContain('.red')
    expect(await promise2).toContain('.red')
  })
})

test('does not register the input file as a dependency, even if it is passed in as relative path', async () => {
  let processor = postcss([
    tailwindcss({ base: `${__dirname}/fixtures/example-project`, optimize: { minify: false } }),
  ])

  let result = await processor.process(`@tailwind utilities`, { from: './input.css' })

  expect(result.css.trim()).toMatchInlineSnapshot(`
    ".underline {
      text-decoration-line: underline;
    }"
  `)

  // Check for dependency messages
  expect(result.messages).not.toContainEqual({
    type: 'dependency',
    file: expect.stringMatching(/input.css$/g),
    parent: expect.any(String),
    plugin: expect.any(String),
  })
})
