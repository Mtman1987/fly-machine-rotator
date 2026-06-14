export interface RepoConfig {
  id: string;
  label: string;
  repoUrl: string;
  cloneDirName: string;
  appNames: string[];
  checkCommands: string[];
  installCommand?: string;
  branchPrefix: string;
}

const REPOS: RepoConfig[] = [
  {
    id: "chat-tag",
    label: "Chat Tag",
    repoUrl: "https://github.com/Mtman1987/chat-tag.git",
    cloneDirName: "chat-tag",
    appNames: ["chat-tag-bot-new", "chat-tag-new"],
    checkCommands: ["npm run typecheck"],
    installCommand: "npm install --no-audit --no-fund",
    branchPrefix: "rotator-fix/chat-tag"
  },
  {
    id: "discord-stream-hub",
    label: "Discord Stream Hub",
    repoUrl: "https://github.com/Mtman1987/DiscordStreamHub.git",
    cloneDirName: "discord-stream-hub",
    appNames: ["discord-stream-hub-new", "dsh-clip-worker"],
    checkCommands: ["npm run typecheck"],
    installCommand: "npm install --no-audit --no-fund",
    branchPrefix: "rotator-fix/dsh"
  },
  {
    id: "hearmeout",
    label: "HearMeOut",
    repoUrl: "https://github.com/Mtman1987/hearmeout-main.git",
    cloneDirName: "hearmeout-main",
    appNames: ["hearmeout-main", "hmo-dj-worker"],
    checkCommands: ["npm run typecheck"],
    installCommand: "npm install --no-audit --no-fund",
    branchPrefix: "rotator-fix/hearmeout"
  },
  {
    id: "streamweaver",
    label: "StreamWeaver",
    repoUrl: "https://github.com/Mtman1987/streamweaver.git",
    cloneDirName: "streamweaver",
    appNames: ["streamweaver-new"],
    checkCommands: ["npm run typecheck"],
    installCommand: "npm install --no-audit --no-fund",
    branchPrefix: "rotator-fix/streamweaver"
  }
];

export function getRepoConfigForApp(appName: string): RepoConfig | undefined {
  return REPOS.find((repo) => repo.appNames.includes(appName));
}

export function listRepoConfigs(): RepoConfig[] {
  return [...REPOS];
}
