---
description: SmartClient UI development — components, DataSources, layouts, grids, forms, trees, charts, drag-drop, validation
---

# SmartClient Showcase Search

You have access to 627 indexed SmartClient showcase examples with neural embeddings. Use these to find working code examples for any SmartClient component, pattern, or feature.

## Showcase Index (static)

The full category tree and component coverage is available at:
`bridge/scripts/sc-showcase-index.md`

Read that file when you need to browse categories or find which components have examples.

## Searching the VectorDB

Search the indexed showcase examples using the bridge CLI:

```bash
node bridge/claude-client.mjs search '{"query":"<natural language query>","limit":5}'
```

### Parameters

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| query | string | required | Natural language search query |
| limit | number | 10 | Max results to return |
| threshold | number | 0.3 | Minimum similarity score (0-1) |
| queryKeywords | string[] | [] | SC component names to boost (lowercase) |

### Result Fields

Each result contains:
- **title**: Example title
- **url**: `smartclient://showcase/<exampleId>`
- **score**: Similarity score (higher = better match)
- **text**: Full source code + description + DataSource XML
- **keywords**: SC components used (e.g. ListGrid, DynamicForm)
- **metadata**: `{ category, exampleId, hasDataSource, source }`

### Query Tips

**By component**: Include the component name naturally
```bash
node bridge/claude-client.mjs search '{"query":"ListGrid with frozen columns","limit":5}'
```

**By pattern**: Describe the UI pattern you need
```bash
node bridge/claude-client.mjs search '{"query":"master-detail grid with form editing","limit":5}'
```

**By feature**: Search for specific capabilities
```bash
node bridge/claude-client.mjs search '{"query":"drag and drop reorder rows","limit":5}'
```

**With keyword boost**: Add queryKeywords for precision
```bash
node bridge/claude-client.mjs search '{"query":"dependent selects","limit":5,"queryKeywords":["selectitem","dynamicform"]}'
```

**By category**: Search within a domain
```bash
node bridge/claude-client.mjs search '{"query":"calendar event editing","limit":5}'
```

## Workflow

1. Search for relevant examples using the CLI above
2. Extract the `text` field from top results — it contains full working source code
3. Adapt the code to the user's requirements
4. Reference the `metadata.exampleId` so the user can view it in the showcase

## SmartClient Best Practices

- Use `isc.defineClass()` or `isc.ClassFactory.defineClass()` for custom components
- DataSources use `isc.DataSource.create({ ID: "...", fields: [...] })`
- Prefer declarative configs over imperative code
- ListGrid fields: `name`, `title`, `type`, `width`, `canEdit`, `optionDataSource`
- Forms use `DynamicForm` with `fields[]` containing typed `FormItem` instances
- Layouts: `VLayout`/`HLayout` with `members[]`, use `layoutMargin` and `membersMargin`
- For dependent selects: use `optionDataSource` + `getPickListFilterCriteria()`
- DataSource operations: `fetchData()`, `addData()`, `updateData()`, `removeData()`
- Use `ValuesManager` to coordinate multiple forms
- Use `SectionStack` for collapsible sections, `TabSet` for tabbed interfaces

## User Request

$ARGUMENTS
