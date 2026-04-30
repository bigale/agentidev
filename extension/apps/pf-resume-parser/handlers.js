/**
 * pf-resume-parser plugin handlers.
 *
 * One handler — PF_RESUME_PARSE — that defines and runs a PocketFlow flow
 * which extracts structured fields (name, email, experience, matched
 * skills) from a resume via the bridge's LLM endpoint.
 *
 * The flow uses call_llm's schema mode so the LLM returns parsed JSON
 * directly (no YAML/markdown unwrapping). A single Node with
 * max_retries=3, wait=2 absorbs transient LLM hiccups.
 *
 * Adapted from cookbook/pocketflow-structured-output (which uses YAML
 * with comments). JSON-via-schema is simpler, deps-free (no PyYAML), and
 * lets the same flow run anywhere our bridge can reach an LLM.
 */

const FLOW_SOURCE = `"""
pf-resume-parser — extract structured fields from a resume.

Single-Node flow with retry. Calls the LLM via agentidev_llm.call_llm
(bridge /llm endpoint). Uses schema mode so the response is parsed JSON
already — no YAML/markdown unwrapping.

Adapted from PocketFlow cookbook/pocketflow-structured-output.
"""
import json
import sys

from agentidev_llm import call_llm
from pocketflow import Flow, Node


RESUME_SCHEMA = {
    "type": "object",
    "required": ["name", "email", "experience", "skill_indexes"],
    "properties": {
        "name":  {"type": "string"},
        "email": {"type": "string"},
        "experience": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["title", "company"],
                "properties": {
                    "title":   {"type": "string"},
                    "company": {"type": "string"},
                },
            },
        },
        "skill_indexes": {
            "type": "array",
            "items": {"type": "integer"},
        },
    },
}


def build_prompt(resume_text, target_skills):
    skill_list = "\\n".join(f"{i}: {s}" for i, s in enumerate(target_skills))
    return f"""Extract structured fields from the resume below.

**Resume:**
\`\`\`
{resume_text}
\`\`\`

**Target Skills (use these indexes):**
\`\`\`
{skill_list}
\`\`\`

Return:
- name (string): full name extracted from the resume
- email (string): email address
- experience: array of {{title, company}} objects, one per job
- skill_indexes: array of integer indexes into the target skills list, one per skill found in the resume
"""


class ResumeParser(Node):
    def __init__(self):
        super().__init__(max_retries=3, wait=2)

    def prep(self, shared):
        return {
            "resume_text": shared.get("resume_text", ""),
            "target_skills": shared.get("target_skills", []),
        }

    def exec(self, prep_res):
        resume = prep_res["resume_text"]
        skills = prep_res["target_skills"]
        if not resume.strip():
            raise ValueError("resume_text is empty")
        if not skills:
            skills = ["Team leadership", "CRM software", "Project management",
                      "Public speaking", "Microsoft Office", "Python", "Data Analysis"]
        prompt = build_prompt(resume, skills)
        # Schema mode: bridge returns the parsed JSON dict directly.
        result = call_llm(prompt, schema=RESUME_SCHEMA, timeout_ms=60000)

        # Lightweight validation in addition to the schema (LLMs occasionally
        # return technically-valid-but-empty data).
        assert "name" in result and result["name"], "missing name"
        assert "email" in result and result["email"], "missing email"
        assert isinstance(result.get("experience"), list), "experience not a list"
        assert isinstance(result.get("skill_indexes"), list), "skill_indexes not a list"

        # Resolve skill indexes to skill names so the UI can display them
        # without re-doing the lookup. Defensive against out-of-range indexes.
        result["matched_skills"] = [
            skills[i] for i in result["skill_indexes"]
            if isinstance(i, int) and 0 <= i < len(skills)
        ]
        return result

    def post(self, shared, prep_res, exec_res):
        shared["parsed"] = exec_res
        shared["matched_skill_count"] = len(exec_res.get("matched_skills", []))
        shared["experience_count"] = len(exec_res.get("experience", []))
        return "default"


def build_flow():
    return Flow(start=ResumeParser())


if __name__ == "__main__":
    shared = None
    if not sys.stdin.isatty():
        raw = sys.stdin.read()
        if raw.strip():
            try: shared = json.loads(raw)
            except json.JSONDecodeError: shared = {}
    if shared is None:
        shared = {}

    flow = build_flow()
    try:
        flow.run(shared)
    except Exception as e:
        shared["error"] = str(e)

    json.dump(shared, sys.stdout, indent=2)
    sys.stdout.write("\\n")
`;

const FLOW_NAME = 'pf-resume-parser';

function parseSkills(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  // Comma-separated string from the form
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

export function register(handlers) {
  handlers['PF_RESUME_PARSE'] = async (msg) => {
    const resumeText = (msg && typeof msg.resume_text === 'string') ? msg.resume_text : '';
    const targetSkills = parseSkills(msg && msg.target_skills);

    if (!resumeText.trim()) {
      return { success: false, error: 'resume_text is required' };
    }

    // Idempotent define — keeps plugin source as the source of truth.
    const defineRes = await handlers['FLOW_DEFINE']({ name: FLOW_NAME, source: FLOW_SOURCE });
    if (!defineRes.success) {
      return { success: false, error: 'flow define failed: ' + (defineRes.error || 'unknown') };
    }

    const runRes = await handlers['FLOW_RUN']({
      name: FLOW_NAME,
      shared: { resume_text: resumeText, target_skills: targetSkills },
      timeout: 90000,
    });

    if (!runRes.success) {
      return {
        success: false,
        error: 'flow run failed: ' + (runRes.error || 'unknown'),
        stderr: runRes.stderr,
      };
    }

    const final = runRes.shared || {};
    if (final.error) {
      return { success: false, error: final.error, shared: final };
    }
    return {
      success: true,
      parsed: final.parsed || null,
      matched_skills: (final.parsed && final.parsed.matched_skills) || [],
      experience_count: final.experience_count || 0,
      matched_skill_count: final.matched_skill_count || 0,
      shared: final,
    };
  };
}
