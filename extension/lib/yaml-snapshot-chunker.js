/**
 * YAML Snapshot Chunker
 *
 * Chunks a full playwright-cli YAML accessibility snapshot (~400 lines)
 * into 5-8 semantic sections based on content markers.
 *
 * Section types:
 *   nav           - Top navigation bar (Bet Now, Offers, etc.)
 *   user_controls - User account area (Bets, Saved, balance)
 *   race_header   - Race info header (track, race number, conditions)
 *   program_tabs  - View selection tabs (PROGRAM, POOLS, PPs, etc.)
 *   bet_controls  - Bet type/amount/modifier dropdowns
 *   runner_table  - Horse entries with odds, jockey, trainer info
 *   bet_slip      - Current bet state (total, save/submit)
 *   sidebar       - Right sidebar panels (Quick Pick, MY BETS, Favorites)
 */

// Section marker patterns
const SECTION_MARKERS = {
  nav: {
    patterns: [/link "Bet Now"/, /link "Offers"/, /link "News & Picks"/, /link "Handicapping"/],
    stable: true,
  },
  user_controls: {
    patterns: [/generic "Bets"/, /generic "Saved"/, /generic "Inbox"/, /balance/],
    stable: false,
  },
  race_header: {
    patterns: [/heading ".*" \[level=2\].*Aqueduct|Tampa|Gulfstream|Oaklawn|Penn|Charles|Turfway/, /RACE \d+/, /CLAIMING/, /Purse:/],
    stable: false,
  },
  program_tabs: {
    patterns: [/listitem.*PROGRAM/, /listitem.*POOLS/, /listitem.*PPs/, /listitem.*STATS/],
    stable: true,
  },
  bet_controls: {
    patterns: [/heading "Exacta"|heading "Win"|heading "Trifecta"|heading "Superfecta"|heading "Daily Double"/, /heading "\$\d+"/, /heading "Key Box"|heading "Box"|heading "Straight"/],
    stable: false,
  },
  runner_table: {
    patterns: [/Runner/, /Jockey/, /Trainer/, /ODDS/, /Sire \/ Dam/],
    stable: false,
  },
  bet_slip: {
    patterns: [/Bet Total:/, /Save Bet/, /Submit Bet/],
    stable: false,
  },
  sidebar: {
    patterns: [/Quick Pick/, /MY BETS/, /Favorites/],
    stable: false,
  },
};

/**
 * Chunk a YAML snapshot into semantic sections
 * @param {string} yamlText - Full YAML accessibility snapshot
 * @param {object} [metadata] - Additional metadata (url, sessionId, etc.)
 * @returns {Array<{sectionType, yamlText, textDescription, metadata}>}
 */
export function chunkYAMLSnapshot(yamlText, metadata = {}) {
  const lines = yamlText.split('\n');
  const chunks = [];

  // First pass: identify section boundaries by scanning for markers
  const sectionBoundaries = identifySections(lines);

  // Second pass: extract chunks
  for (const boundary of sectionBoundaries) {
    const sectionLines = lines.slice(boundary.startLine, boundary.endLine);
    const sectionYaml = sectionLines.join('\n');

    if (sectionYaml.trim().length === 0) continue;

    const textDesc = generateTextDescription(boundary.type, sectionYaml, metadata);

    chunks.push({
      sectionType: boundary.type,
      yamlText: sectionYaml,
      textDescription: textDesc,
      metadata: {
        startLine: boundary.startLine,
        endLine: boundary.endLine,
        lineCount: sectionLines.length,
        ...metadata,
      },
    });
  }

  // If no sections identified, return the whole thing as a single chunk
  if (chunks.length === 0) {
    chunks.push({
      sectionType: 'full_page',
      yamlText,
      textDescription: generateTextDescription('full_page', yamlText, metadata),
      metadata: {
        startLine: 0,
        endLine: lines.length,
        lineCount: lines.length,
        ...metadata,
      },
    });
  }

  return chunks;
}

/**
 * Identify section boundaries by scanning for content markers
 * @param {string[]} lines - YAML lines
 * @returns {Array<{type, startLine, endLine}>}
 */
function identifySections(lines) {
  const sections = [];
  let currentSection = null;
  let lastSectionEnd = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = getIndentLevel(line);

    // Check each section type
    for (const [sectionType, config] of Object.entries(SECTION_MARKERS)) {
      for (const pattern of config.patterns) {
        if (pattern.test(line)) {
          // Found a marker - determine section boundaries
          // Walk back to find section start (parent element at lower indent)
          const startLine = findSectionStart(lines, i, indent);

          if (currentSection) {
            // Close previous section
            currentSection.endLine = startLine;
            if (currentSection.endLine > currentSection.startLine) {
              sections.push({ ...currentSection });
            }
          }

          currentSection = {
            type: sectionType,
            startLine,
            endLine: lines.length, // Will be adjusted
          };

          lastSectionEnd = i;
          break;
        }
      }
    }
  }

  // Close last section
  if (currentSection) {
    currentSection.endLine = lines.length;
    sections.push(currentSection);
  }

  // Deduplicate overlapping sections (keep the more specific one)
  return deduplicateSections(sections);
}

/**
 * Find the start of a section by walking backwards to a parent element
 */
function findSectionStart(lines, markerLine, markerIndent) {
  // Walk backwards to find a line at a lower indent level (parent container)
  const targetIndent = Math.max(0, markerIndent - 2);
  for (let i = markerLine - 1; i >= 0; i--) {
    const indent = getIndentLevel(lines[i]);
    if (indent <= targetIndent && lines[i].trim().length > 0) {
      return i;
    }
  }
  return Math.max(0, markerLine - 5); // Fallback: 5 lines before marker
}

/**
 * Get indent level (number of leading spaces / 2)
 */
function getIndentLevel(line) {
  const match = line.match(/^(\s*)/);
  return match ? Math.floor(match[1].length / 2) : 0;
}

/**
 * Remove overlapping sections, keeping the more specific one
 */
function deduplicateSections(sections) {
  if (sections.length <= 1) return sections;

  // Sort by start line
  sections.sort((a, b) => a.startLine - b.startLine);

  const result = [];
  for (const section of sections) {
    // Check if this overlaps with a previous section of same type
    const existing = result.find(s =>
      s.type === section.type &&
      s.startLine === section.startLine
    );
    if (!existing) {
      result.push(section);
    }
  }

  // Trim end lines to avoid overlaps
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i].endLine > result[i + 1].startLine) {
      result[i].endLine = result[i + 1].startLine;
    }
  }

  return result.filter(s => s.endLine > s.startLine);
}

/**
 * Generate a natural language description of a YAML section
 * Used as input text for embedding generation
 * @param {string} sectionType
 * @param {string} yamlChunk
 * @param {object} metadata
 * @returns {string}
 */
export function generateTextDescription(sectionType, yamlChunk, metadata = {}) {
  switch (sectionType) {
    case 'nav':
      return describeNav(yamlChunk);
    case 'user_controls':
      return describeUserControls(yamlChunk);
    case 'race_header':
      return describeRaceHeader(yamlChunk, metadata);
    case 'program_tabs':
      return describeProgramTabs(yamlChunk);
    case 'bet_controls':
      return describeBetControls(yamlChunk, metadata);
    case 'runner_table':
      return describeRunnerTable(yamlChunk, metadata);
    case 'bet_slip':
      return describeBetSlip(yamlChunk, metadata);
    case 'sidebar':
      return describeSidebar(yamlChunk);
    case 'full_page':
      return describeFullPage(yamlChunk, metadata);
    default:
      return `Unknown section type ${sectionType} with ${yamlChunk.split('\n').length} lines`;
  }
}

function describeNav(yaml) {
  const links = [];
  const linkPattern = /link "([^"]+)"/g;
  let match;
  while ((match = linkPattern.exec(yaml)) !== null) {
    links.push(match[1]);
  }
  return `Navigation bar with links: ${links.join(', ')}`;
}

function describeUserControls(yaml) {
  const parts = [];
  if (/Bets/.test(yaml)) {
    const countMatch = yaml.match(/generic \[ref=e\d+\]: "(\d+)"/);
    parts.push(`Bets${countMatch ? ` (${countMatch[1]})` : ''}`);
  }
  if (/Saved/.test(yaml)) parts.push('Saved');
  if (/Inbox/.test(yaml)) parts.push('Inbox');
  if (/balance/.test(yaml)) parts.push('Balance');
  return `User controls: ${parts.join(', ')}`;
}

function describeRaceHeader(yaml, metadata) {
  const track = metadata.track || extractPattern(yaml, /heading "([^"]+)" \[level=2\]/);
  const race = extractPattern(yaml, /RACE (\d+)/);
  const conditions = extractPattern(yaml, /\$\d+K?\s+CLAIMING|ALLOWANCE|MAIDEN|STARTER/i);
  const purse = extractPattern(yaml, /Purse: \$([^\s"]+)/);
  const distance = extractPattern(yaml, /\d+ F|\d+ M/);

  const parts = [];
  if (track) parts.push(track);
  if (race) parts.push(`Race ${race}`);
  if (conditions) parts.push(conditions);
  if (purse) parts.push(`Purse $${purse}`);
  if (distance) parts.push(distance);

  return `Race header: ${parts.join(', ')}`;
}

function describeProgramTabs(yaml) {
  const tabs = [];
  const tabPattern = /listitem.*?: (PROGRAM|POOLS|PPs|STATS|RESULTS|VIDEO|BET PAD)/g;
  let match;
  while ((match = tabPattern.exec(yaml)) !== null) {
    tabs.push(match[1]);
  }
  return `Program view tabs: ${tabs.join(', ')}`;
}

function describeBetControls(yaml, metadata) {
  const betType = extractPattern(yaml, /heading "(Exacta|Win|Trifecta|Superfecta|Daily Double|Pick \d|Quinella)"/i);
  const amount = extractPattern(yaml, /heading "\$([^"]+)"/);
  const modifier = extractPattern(yaml, /heading "(Key Box|Box|Straight|Key|Wheel)"/i);

  const parts = [];
  if (betType) parts.push(betType);
  if (amount) parts.push(`$${amount}`);
  if (modifier) parts.push(modifier);

  return `Bet controls: ${parts.join(', ')}`;
}

function describeRunnerTable(yaml, metadata) {
  const runners = [];
  // Match horse names (they appear after "expert Nth pick" or standalone)
  const lines = yaml.split('\n');
  let currentPP = null;
  let currentName = null;
  let currentOdds = null;

  for (const line of lines) {
    // PP number
    const ppMatch = line.match(/PP (\d+)/);
    if (ppMatch) currentPP = ppMatch[1];

    // Odds (like 7/2, 9/2, or standalone numbers)
    const oddsMatch = line.match(/generic \[ref=e\d+\]: (\d+\/\d+|"\d+")/);
    if (oddsMatch && currentPP) {
      currentOdds = oddsMatch[1].replace(/"/g, '');
    }

    // Horse name (usually after expert pick or standalone text)
    const nameMatch = line.match(/generic \[ref=e\d+\]: ([A-Z][a-z]+ [A-Z][a-z]+.*?)$/);
    if (nameMatch && !/Bay|Chestnut|Dark|Gray|Gelding|Horse|Mare|Filly|yrs/.test(nameMatch[1])) {
      currentName = nameMatch[1];
    }

    // Also catch names in quoted format
    const quotedNameMatch = line.match(/generic "(\d+): ([^"]+)"/);
    if (quotedNameMatch) {
      currentPP = quotedNameMatch[1];
      currentName = quotedNameMatch[2];
    }

    // When we have a complete runner entry, save it
    if (currentPP && currentName) {
      runners.push(`PP${currentPP} ${currentName}${currentOdds ? ` ${currentOdds}` : ''}`);
      currentPP = null;
      currentName = null;
      currentOdds = null;
    }
  }

  const track = metadata.track || '';
  const race = metadata.race || '';

  if (runners.length > 0) {
    return `Runner table at ${track} Race ${race}: ${runners.join(', ')}`;
  }
  return `Runner table at ${track} Race ${race} (${lines.length} lines)`;
}

function describeBetSlip(yaml, metadata) {
  const total = extractPattern(yaml, /Bet Total:.*?\$([0-9.]+)/);
  const track = metadata.track || '';
  const race = metadata.race || '';
  const betType = extractPattern(yaml, /EX|TR|SU|WN|DD|PK/);

  const parts = [`Bet slip for ${track} Race ${race}`];
  if (betType) parts.push(betType);
  if (total) parts.push(`Total: $${total}`);
  if (/Save Bet/.test(yaml)) parts.push('Save available');
  if (/Submit Bet/.test(yaml)) parts.push('Submit available');

  return parts.join(', ');
}

function describeSidebar(yaml) {
  const panels = [];
  if (/Quick Pick/.test(yaml)) panels.push('Quick Pick');
  if (/MY BETS/.test(yaml)) panels.push('My Bets');
  if (/Favorites/.test(yaml)) panels.push('Favorites');
  if (/POOLS/.test(yaml)) panels.push('Pools');
  return `Sidebar panels: ${panels.join(', ')}`;
}

function describeFullPage(yaml, metadata) {
  const parts = [];

  // Use track/race if available (TwinSpires)
  if (metadata.track) {
    parts.push(`${metadata.track}${metadata.race ? ` Race ${metadata.race}` : ''}`);
  }

  // Extract headings
  const headings = [];
  const headingPattern = /heading "([^"]+)"/g;
  let m;
  while ((m = headingPattern.exec(yaml)) !== null) {
    headings.push(m[1]);
  }
  if (headings.length > 0) {
    parts.push(`Headings: ${headings.slice(0, 10).join(', ')}`);
  }

  // Extract links
  const links = [];
  const linkPattern = /link "([^"]+)"/g;
  while ((m = linkPattern.exec(yaml)) !== null) {
    links.push(m[1]);
  }
  if (links.length > 0) {
    parts.push(`Links: ${links.slice(0, 10).join(', ')}`);
  }

  // Extract visible text snippets
  const textPattern = /:\s+([A-Z][^[\n]{10,80})/g;
  const texts = [];
  while ((m = textPattern.exec(yaml)) !== null) {
    texts.push(m[1].trim());
  }
  if (texts.length > 0) {
    parts.push(`Content: ${texts.slice(0, 5).join('; ')}`);
  }

  if (parts.length === 0) {
    parts.push(`Page snapshot (${yaml.split('\n').length} lines)`);
  }

  return parts.join('. ');
}

/**
 * Extract a pattern match from text
 */
function extractPattern(text, pattern) {
  const match = text.match(pattern);
  return match ? (match[1] || match[0]) : null;
}

/**
 * Strip element refs [ref=eNNN] for structural comparison
 * @param {string} yamlChunk
 * @returns {string} Normalized YAML
 */
export function normalizeStructure(yamlChunk) {
  return yamlChunk
    .replace(/\[ref=e?\d+\]/g, '[ref=*]')
    .replace(/\[ref=f\w+\]/g, '[ref=*]')
    .replace(/"[\d,]+"/g, '"*"')
    .replace(/\$[\d,.]+/g, '$*');
}

/**
 * Extract race metadata from a full YAML snapshot
 * @param {string} yamlText
 * @returns {object} { track, race, betType, betAmount, horses }
 */
export function extractRaceMetadata(yamlText) {
  const metadata = {
    track: null,
    race: null,
    betType: null,
    betAmount: null,
    horses: [],
  };

  // Track name - from heading with track name
  const trackPatterns = [
    /heading "(\w[\w\s]+)" \[level=2\]/,
    /heading "(Aqueduct|Tampa Bay|Gulfstream|Oaklawn|Penn National|Charles Town|Turfway|Santa Anita|Del Mar|Saratoga|Belmont|Churchill|Keeneland|Pimlico|Laurel)/i,
  ];
  for (const pattern of trackPatterns) {
    const match = yamlText.match(pattern);
    if (match) {
      metadata.track = match[1];
      break;
    }
  }

  // Race number
  const raceMatch = yamlText.match(/RACE (\d+)/);
  if (raceMatch) {
    metadata.race = raceMatch[1];
  }

  // Bet type
  const betTypeMatch = yamlText.match(/heading "(Exacta|Win|Trifecta|Superfecta|Daily Double|Pick \d|Quinella)"/i);
  if (betTypeMatch) {
    metadata.betType = betTypeMatch[1];
  }

  // Bet amount
  const amountMatch = yamlText.match(/heading "\$([^"]+)"/);
  if (amountMatch) {
    metadata.betAmount = amountMatch[1];
  }

  // Horse names
  const horsePattern = /generic "(\d+): ([^"]+)"/g;
  let horseMatch;
  while ((horseMatch = horsePattern.exec(yamlText)) !== null) {
    metadata.horses.push({ pp: horseMatch[1], name: horseMatch[2] });
  }

  return metadata;
}
