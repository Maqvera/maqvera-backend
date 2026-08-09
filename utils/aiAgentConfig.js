import dotenv from "dotenv";
dotenv.config();

/**
 * EXT-035 "AI Agent Framework & Multi-Agent Orchestration" configuration.
 * Config-driven per this codebase's own convention (CLAUDE.md
 * "Config-driven domain values").
 */
export const getAIAgentConfig = () => ({
  // §19 "Security ... every agent validates ... Policies." §21 "Only
  // authorized administrators may transition agent lifecycle" — admin
  // always has this too.
  managePermission: process.env.AI_AGENT_MANAGE_PERMISSION || "ai.agent.manage"
});

export default getAIAgentConfig;
