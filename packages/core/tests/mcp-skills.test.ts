import { describe, expect, it } from 'vitest';
import { ASSISTANT_TOOLS, atLeast, isAssistantTool, MCP_SKILLS, mcpSkillFiles } from '../src';

const frontmatter = (md: string) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) throw new Error('No frontmatter');
  return m[1]!;
};

describe('MCP skills', () => {
  for (const [name, skill] of Object.entries(MCP_SKILLS)) {
    describe(name, () => {
      const md = skill.files['SKILL.md']!;

      it('is a valid Agent Skill named for its folder, with its role', () => {
        expect(md).toBeDefined();
        const fm = frontmatter(md);
        expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(fm).toMatch(new RegExp(`^name: ${name}$`, 'm'));
        const description = /^description: (.+)$/m.exec(fm)?.[1];
        expect(description?.length).toBeGreaterThan(20);
        expect(description!.length).toBeLessThanOrEqual(1024);
        expect(fm).toMatch(new RegExp(`^metadata:\\n  role: ${skill.role}$`, 'm'));
      });

      it('names only real tools, all within its role', () => {
        const named = [...md.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!);
        expect(named.length).toBeGreaterThan(0);
        for (const tool of named) {
          expect(isAssistantTool(tool), tool).toBe(true);
          if (isAssistantTool(tool))
            expect(atLeast(skill.role, ASSISTANT_TOOLS[tool].role), tool).toBe(true);
        }
      });
    });
  }

  it('offers each role only the skills it can follow', () => {
    expect(Object.keys(mcpSkillFiles('viewer'))).toEqual(['triage-attention/SKILL.md']);
    expect(Object.keys(mcpSkillFiles('approver')).sort()).toEqual([
      'review-approval/SKILL.md',
      'triage-attention/SKILL.md',
    ]);
    expect(Object.keys(mcpSkillFiles('operator'))).toHaveLength(4);
  });
});
