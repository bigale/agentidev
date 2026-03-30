/**
 * Tests for templates.js — Bundled templates + TemplateManager.
 */

const { TemplateManager, BUNDLED_TEMPLATES } = require('../extension/smartclient-app/templates.js');

// --- Bundled template validation ---

describe('bundled templates', () => {
  test('all 7 templates are present', () => {
    expect(BUNDLED_TEMPLATES.length).toBe(7);
  });

  test('each template has required fields', () => {
    BUNDLED_TEMPLATES.forEach((tpl) => {
      expect(tpl.id).toBeTruthy();
      expect(tpl.name).toBeTruthy();
      expect(tpl.description).toBeTruthy();
      expect(tpl.category).toBeTruthy();
      expect(Array.isArray(tpl.tags)).toBe(true);
      expect(tpl.config).toBeTruthy();
      expect(tpl.config.layout).toBeTruthy();
      expect(Array.isArray(tpl.config.dataSources)).toBe(true);
      expect(typeof tpl.aiSystemPrompt).toBe('string');
      expect(Array.isArray(tpl.suggestedPrompts)).toBe(true);
    });
  });

  test('each template has unique ID', () => {
    const ids = BUNDLED_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('each template config has valid layout with _type', () => {
    BUNDLED_TEMPLATES.forEach((tpl) => {
      expect(tpl.config.layout._type).toBeTruthy();
    });
  });

  test('templates with dataSources have fields on each DS', () => {
    BUNDLED_TEMPLATES.forEach((tpl) => {
      tpl.config.dataSources.forEach((ds) => {
        expect(ds.ID).toBeTruthy();
        expect(Array.isArray(ds.fields)).toBe(true);
        expect(ds.fields.length).toBeGreaterThan(0);
      });
    });
  });

  test('suggested prompts are non-empty arrays', () => {
    BUNDLED_TEMPLATES.forEach((tpl) => {
      if (tpl.id !== 'tpl_blank') {
        expect(tpl.suggestedPrompts.length).toBeGreaterThanOrEqual(3);
      }
    });
  });
});

// --- TemplateManager ---

describe('TemplateManager.getBundled', () => {
  test('returns all bundled templates with bundled flag', () => {
    const all = TemplateManager.getBundled();
    expect(all.length).toBe(7);
    all.forEach((t) => expect(t.bundled).toBe(true));
  });

  test('returns copies, not originals', () => {
    const all = TemplateManager.getBundled();
    all[0].name = 'MUTATED';
    expect(TemplateManager.getBundled()[0].name).not.toBe('MUTATED');
  });
});

describe('TemplateManager.getById', () => {
  test('returns correct template', () => {
    const tpl = TemplateManager.getById('tpl_crud');
    expect(tpl).not.toBeNull();
    expect(tpl.name).toBe('CRUD Manager');
    expect(tpl.bundled).toBe(true);
  });

  test('returns null for unknown ID', () => {
    expect(TemplateManager.getById('tpl_nonexistent')).toBeNull();
  });
});

describe('TemplateManager.getByCategory', () => {
  test('returns templates in Data category', () => {
    const data = TemplateManager.getByCategory('Data');
    expect(data.length).toBeGreaterThanOrEqual(2);
    data.forEach((t) => expect(t.category).toBe('Data'));
  });

  test('returns empty for unknown category', () => {
    expect(TemplateManager.getByCategory('Nonexistent')).toEqual([]);
  });
});

describe('TemplateManager.getCategories', () => {
  test('returns sorted category list', () => {
    const cats = TemplateManager.getCategories();
    expect(cats.length).toBeGreaterThanOrEqual(3);
    // Should be sorted
    const sorted = [...cats].sort();
    expect(cats).toEqual(sorted);
  });
});

describe('TemplateManager.validate', () => {
  test('validates complete template', () => {
    const result = TemplateManager.validate(BUNDLED_TEMPLATES[0]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('catches missing fields', () => {
    const result = TemplateManager.validate({ name: 'X' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing id');
    expect(result.errors).toContain('Missing config');
  });

  test('catches missing config.layout', () => {
    const result = TemplateManager.validate({
      id: 'x', name: 'X', config: { dataSources: [] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Config missing layout');
  });

  test('catches null template', () => {
    const result = TemplateManager.validate(null);
    expect(result.valid).toBe(false);
  });
});

describe('TemplateManager.createUserTemplate', () => {
  test('creates template with proper structure', () => {
    const tpl = TemplateManager.createUserTemplate({
      name: 'My Template',
      description: 'Test template',
      category: 'Custom',
      config: { dataSources: [], layout: { _type: 'VLayout' } },
      aiSystemPrompt: 'Custom prompt',
      suggestedPrompts: ['Do this', 'Do that'],
    });

    expect(tpl.id).toMatch(/^tpl_user_/);
    expect(tpl.name).toBe('My Template');
    expect(tpl.bundled).toBe(false);
    expect(tpl.createdAt).toBeTruthy();
    expect(tpl.config.layout._type).toBe('VLayout');

    // Validate it passes validation
    const result = TemplateManager.validate(tpl);
    expect(result.valid).toBe(true);
  });

  test('deep-clones config', () => {
    const config = { dataSources: [], layout: { _type: 'VLayout', members: [] } };
    const tpl = TemplateManager.createUserTemplate({ name: 'T', config: config });
    config.layout.members.push({ _type: 'Button' });
    expect(tpl.config.layout.members.length).toBe(0);
  });

  test('uses defaults for optional fields', () => {
    const tpl = TemplateManager.createUserTemplate({
      name: 'Minimal',
      config: { dataSources: [], layout: { _type: 'VLayout' } },
    });
    expect(tpl.description).toBe('');
    expect(tpl.category).toBe('Custom');
    expect(tpl.aiSystemPrompt).toBe('');
    expect(tpl.suggestedPrompts).toEqual([]);
  });
});

// --- AI prompt injection ---

describe('AI prompt integration', () => {
  test('CRUD template has actionable AI prompt', () => {
    const tpl = TemplateManager.getById('tpl_crud');
    expect(tpl.aiSystemPrompt).toContain('CRUD');
    expect(tpl.aiSystemPrompt.length).toBeGreaterThan(50);
  });

  test('Calculator template mentions compute action', () => {
    const tpl = TemplateManager.getById('tpl_calculator');
    expect(tpl.aiSystemPrompt).toContain('compute');
  });

  test('Wizard template mentions ForgeWizard', () => {
    const tpl = TemplateManager.getById('tpl_wizard');
    expect(tpl.aiSystemPrompt).toContain('ForgeWizard');
  });

  test('Blank template has empty AI prompt', () => {
    const tpl = TemplateManager.getById('tpl_blank');
    expect(tpl.aiSystemPrompt).toBe('');
  });
});
