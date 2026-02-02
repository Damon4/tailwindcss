import path from 'node:path'
import type * as postcss from 'postcss'
import { SourceMapConsumer, type RawSourceMap } from 'source-map-js'
import { atRule, comment, decl, rule, type AstNode } from '../../tailwindcss/src/ast'
import { createLineTable, type LineTable } from '../../tailwindcss/src/source-maps/line-table'
import type { Source, SourceLocation } from '../../tailwindcss/src/source-maps/source'
import { DefaultMap } from '../../tailwindcss/src/utils/default-map'

const EXCLAMATION_MARK = 0x21
const DEBUG =
  process.env.DEBUG?.includes('@tailwindcss/postcss') || process.env.DEBUG?.includes('tailwindcss')

export function cssAstToPostCssAst(
  postcss: postcss.Postcss,
  ast: AstNode[],
  source?: postcss.Source,
): postcss.Root {
  let inputMap = new DefaultMap<Source, postcss.Input>((src) => {
    let map: postcss.Result['map'] | undefined

    if (source?.input.map && typeof source.input.map.toJSON === 'function') {
      let sources = source.input.map.toJSON().sources ?? []
      let file = src.file ?? undefined

      let shouldUseMap = false
      if (!file) {
        shouldUseMap = true
      } else if (sources.includes(file)) {
        shouldUseMap = true
      } else {
        let fileName = path.basename(file)
        shouldUseMap = sources.some((sourceFile) => path.basename(sourceFile) === fileName)
      }

      if (shouldUseMap) {
        map = source.input.map
      }
    }

    return new postcss.Input(src.code, {
      map,
      from: src.file ?? undefined,
    })
  })

  let lineTables = new DefaultMap<Source, LineTable>((src) => createLineTable(src.code))

  let root = postcss.root()
  root.source = source

  function toSource(loc: SourceLocation | undefined): postcss.Source | undefined {
    // Use the fallback if this node has no location info in the AST
    if (!loc) return
    if (!loc[0]) return

    let table = lineTables.get(loc[0])
    let start = table.find(loc[1])
    let end = table.find(loc[2])

    return {
      input: inputMap.get(loc[0]),
      start: {
        line: start.line,
        column: start.column + 1,
        offset: loc[1],
      },
      end: {
        line: end.line,
        column: end.column + 1,
        offset: loc[2],
      },
    }
  }

  function updateSource(astNode: postcss.ChildNode, loc: SourceLocation | undefined) {
    let source = toSource(loc)

    // The `source` property on PostCSS nodes must be defined if present because
    // `toJSON()` reads each property and tries to read from source.input if it
    // sees a `source` property. This means for a missing or otherwise absent
    // source it must be *missing* from the object rather than just `undefined`
    if (source) {
      astNode.source = source
    } else {
      delete astNode.source
    }
  }

  function transform(node: AstNode, parent: postcss.Container) {
    // Declaration
    if (node.kind === 'declaration') {
      let astNode = postcss.decl({
        prop: node.property,
        value: node.value ?? '',
        important: node.important,
      })
      updateSource(astNode, node.src)
      parent.append(astNode)
    }

    // Rule
    else if (node.kind === 'rule') {
      let astNode = postcss.rule({ selector: node.selector })
      updateSource(astNode, node.src)
      astNode.raws.semicolon = true
      parent.append(astNode)
      for (let child of node.nodes) {
        transform(child, astNode)
      }
    }

    // AtRule
    else if (node.kind === 'at-rule') {
      let astNode = postcss.atRule({ name: node.name.slice(1), params: node.params })
      updateSource(astNode, node.src)
      astNode.raws.semicolon = true
      parent.append(astNode)
      for (let child of node.nodes) {
        transform(child, astNode)
      }
    }

    // Comment
    else if (node.kind === 'comment') {
      let astNode = postcss.comment({ text: node.value })
      // Spaces are encoded in our node.value already, no need to add additional
      // spaces.
      astNode.raws.left = ''
      astNode.raws.right = ''
      updateSource(astNode, node.src)
      parent.append(astNode)
    }

    // AtRoot & Context should not happen
    else if (node.kind === 'at-root' || node.kind === 'context') {
    }

    // Unknown
    else {
      node satisfies never
    }
  }

  for (let node of ast) {
    transform(node, root)
  }

  return root
}

export function postCssAstToCssAst(root: postcss.Root): AstNode[] {
  function getRawMap(input: postcss.Input): RawSourceMap | null {
    let map = input.map
    if (!map) return null

    if (typeof map.toJSON === 'function') {
      return map.toJSON() as RawSourceMap
    }

    if ('sources' in map) {
      return map as RawSourceMap
    }

    if (typeof map === 'object' && map !== null && 'text' in map) {
      let text = (map as { text?: unknown }).text
      if (typeof text === 'string') {
        try {
          return JSON.parse(text) as RawSourceMap
        } catch {
          // Ignore invalid JSON
        }
      } else if (text && typeof text === 'object' && 'sources' in (text as object)) {
        return text as RawSourceMap
      }
    }

    DEBUG &&
      console.warn('[tw-postcss:sourcemap] unrecognized input.map', {
        inputFile: input.file ?? input.id ?? null,
        mapType: typeof map,
        mapKeys: typeof map === 'object' && map !== null ? Object.keys(map as object) : null,
      })

    return null
  }

  let rawMapCache = new DefaultMap<postcss.Input, RawSourceMap | null>((input) => getRawMap(input))

  let consumerCache = new DefaultMap<postcss.Input, SourceMapConsumer | null>((input) => {
    let rawMap = rawMapCache.get(input)
    if (!rawMap) return null
    return new SourceMapConsumer(rawMap)
  })

  function normalizeSourceName(source: string) {
    let cleaned = source
    let queryIndex = cleaned.indexOf('?')
    if (queryIndex !== -1) cleaned = cleaned.slice(0, queryIndex)
    let hashIndex = cleaned.indexOf('#')
    if (hashIndex !== -1) cleaned = cleaned.slice(0, hashIndex)

    if (cleaned.startsWith('file://')) {
      try {
        return decodeURIComponent(new URL(cleaned).pathname)
      } catch {
        return cleaned.slice('file://'.length)
      }
    }
    if (/^[a-z]+:\/\//i.test(cleaned)) {
      cleaned = cleaned.replace(/^[a-z]+:\/\//i, '')
      cleaned = cleaned.replace(/^\/+/, '')
    }

    cleaned = cleaned.replace(/\/\.(?=\/)/g, '')

    if (cleaned.startsWith('./')) cleaned = cleaned.slice(2)

    return cleaned
  }

  let sourcesContentCache = new DefaultMap<postcss.Input, Map<string, string | null>>((input) => {
    let map = new Map<string, string | null>()

    let consumer = consumerCache.get(input)
    if (consumer) {
      for (let source of consumer.sources) {
        let content: string | null
        try {
          content = consumer.sourceContentFor(source, true) ?? null
        } catch {
          content = null
        }
        map.set(source, content)
      }
      return map
    }

    let rawMap = rawMapCache.get(input)
    let sources = rawMap?.sources ?? []
    let contents = rawMap?.sourcesContent ?? []

    for (let i = 0; i < sources.length; i++) {
      map.set(sources[i], contents[i] ?? null)
    }

    return map
  })

  let normalizedSourcesCache = new DefaultMap<postcss.Input, Map<string, string>>((input) => {
    let map = new Map<string, string>()

    let consumer = consumerCache.get(input)
    let sources = consumer?.sources ?? rawMapCache.get(input)?.sources ?? []

    for (let source of sources) {
      let normalized = normalizeSourceName(source)
      map.set(source, source)
      map.set(normalized, source)
      map.set(path.basename(source), source)
      map.set(path.basename(normalized), source)
    }

    return map
  })

  function resolveSourceContent(input: postcss.Input, file: string) {
    let rawMap = rawMapCache.get(input)
    if (!rawMap) {
      DEBUG &&
        console.warn('[tw-postcss:sourcemap] missing raw map', {
          file,
          inputFile: input.file ?? input.id ?? null,
        })
      return {
        sourceName: file,
        content: null as string | null,
      }
    }

    let normalizedSources = normalizedSourcesCache.get(input)
    let matchedSource = normalizedSources.get(file)
    if (!matchedSource) {
      let normalized = normalizeSourceName(file)
      matchedSource =
        normalizedSources.get(normalized) ??
        normalizedSources.get(path.basename(normalized)) ??
        normalizedSources.get(path.basename(file))

      if (!matchedSource) {
        for (let [key, value] of normalizedSources) {
          if (key.endsWith(normalized) || normalized.endsWith(key)) {
            matchedSource = value
            break
          }
        }
      }
    }

    let sourceName = matchedSource ?? file
    let content = sourcesContentCache.get(input).get(sourceName) ?? null

    if (input.file) {
      let inputBase = path.basename(input.file)
      let sourceBase = path.basename(sourceName)

      if (inputBase === sourceBase) {
        let normalizedSource = normalizeSourceName(sourceName)
        if (normalizedSource === sourceBase) {
          sourceName = input.file
        }
      }
    }

    if (DEBUG) {
      let normalized = normalizeSourceName(file)
      let sources = consumerCache.get(input)?.sources ?? rawMap.sources
      console.warn('[tw-postcss:sourcemap] resolve', {
        file,
        normalized,
        matchedSource: matchedSource ?? null,
        sourceName,
        hasContent: content !== null,
        sourcesCount: sources.length,
      })
    }

    return {
      sourceName,
      content,
    }
  }

  let sourceObjectCache = new DefaultMap<postcss.Input, DefaultMap<string, Source>>(
    (input) =>
      new DefaultMap((file) => {
        let { sourceName, content } = resolveSourceContent(input, file)
        return {
          file: sourceName,
          code: content ?? input.css,
        }
      }),
  )

  let inputMap = new DefaultMap<postcss.Input, Source>((input) => {
    let file = input.file ?? input.id ?? null

    let rawMap = rawMapCache.get(input)
    if (rawMap && rawMap.sources.length > 0) {
      file = rawMap.sources[0]
    }

    return {
      file,
      code: input.css,
    }
  })

  function toSource(node: postcss.ChildNode): SourceLocation | undefined {
    let source = node.source
    if (!source) return

    let input = source.input
    if (!input) return
    if (source.start === undefined) return
    if (source.end === undefined) return

    let consumer = consumerCache.get(input)

    if (DEBUG && !consumer) {
      let rawMap = rawMapCache.get(input)
      console.warn('[tw-postcss:sourcemap] no consumer', {
        inputFile: input.file ?? input.id ?? null,
        hasRawMap: rawMap !== null,
        sourcesCount: rawMap?.sources?.length ?? 0,
        sourcesContentCount: rawMap?.sourcesContent?.length ?? 0,
        sourceRoot: rawMap?.sourceRoot ?? null,
      })
    }

    if (consumer) {
      let start = consumer.originalPositionFor(
        {
          line: source.start.line,
          column: Math.max(source.start.column - 1, 0),
        },
        SourceMapConsumer.LEAST_UPPER_BOUND,
      )
      let end = consumer.originalPositionFor(
        {
          line: source.end.line,
          column: Math.max(source.end.column - 1, 0),
        },
        SourceMapConsumer.GREATEST_LOWER_BOUND,
      )

      if (!end.source) {
        let endUpper = consumer.originalPositionFor(
          {
            line: source.end.line,
            column: Math.max(source.end.column - 1, 0),
          },
          SourceMapConsumer.LEAST_UPPER_BOUND,
        )

        if (endUpper.source) {
          end = endUpper
        }
      }

      if (!start.source) {
        let startLower = consumer.originalPositionFor(
          {
            line: source.start.line,
            column: Math.max(source.start.column - 1, 0),
          },
          SourceMapConsumer.GREATEST_LOWER_BOUND,
        )

        if (startLower.source) {
          start = startLower
        }
      }

      if (start.source && !end.source) {
        end = start
      } else if (!start.source && end.source) {
        start = end
      }

      if (DEBUG && (!start.source || !end.source)) {
        let rawMap = rawMapCache.get(input)
        console.warn('[tw-postcss:sourcemap] missing original source', {
          inputFile: input.file ?? input.id ?? null,
          start,
          end,
          sourcesCount: rawMap?.sources?.length ?? 0,
          sourcesContentCount: rawMap?.sourcesContent?.length ?? 0,
          sourceRoot: rawMap?.sourceRoot ?? null,
        })
      }

      if (start.source && end.source) {
        let file = start.source
        let sourceObject = sourceObjectCache.get(input).get(file)
        let table = createLineTable(sourceObject.code)

        let startOffset = table.findOffset({
          line: start.line ?? 1,
          column: start.column ?? 0,
        })
        let endOffset = table.findOffset({
          line: end.line ?? 1,
          column: end.column ?? 0,
        })

        if (endOffset < startOffset) {
          endOffset = startOffset
        }

        return [sourceObject, startOffset, endOffset]
      }
    }

    return [inputMap.get(input), source.start.offset, source.end.offset]
  }

  function transform(
    node: postcss.ChildNode,
    parent: Extract<AstNode, { nodes: AstNode[] }>['nodes'],
  ) {
    // Declaration
    if (node.type === 'decl') {
      let astNode = decl(node.prop, node.value, node.important)
      astNode.src = toSource(node)
      parent.push(astNode)
    }

    // Rule
    else if (node.type === 'rule') {
      let astNode = rule(node.selector)
      astNode.src = toSource(node)
      node.each((child) => transform(child, astNode.nodes))
      parent.push(astNode)
    }

    // AtRule
    else if (node.type === 'atrule') {
      let astNode = atRule(`@${node.name}`, node.params)
      astNode.src = toSource(node)
      node.each((child) => transform(child, astNode.nodes))
      parent.push(astNode)
    }

    // Comment
    else if (node.type === 'comment') {
      if (node.text.charCodeAt(0) !== EXCLAMATION_MARK) return
      let astNode = comment(node.text)
      astNode.src = toSource(node)
      parent.push(astNode)
    }

    // Unknown
    else {
      node satisfies never
    }
  }

  let ast: AstNode[] = []
  root.each((node) => transform(node, ast))

  return ast
}
