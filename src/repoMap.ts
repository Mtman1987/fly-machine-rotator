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
    id: "spmt-live",
    label: "SPMT Live / Athena OS",
    repoUrl: "https://github.com/Mtman1987/spmt-live.git",
    cloneDirName: "spmt-live",
    appNames: ["spmt-live", "spacemountain-live"],
    checkCommands: ["npm run typecheck", "npm run build"],
    installCommand: "npm install --include=dev --no-audit --no-fund",
    branchPrefix: "rotator-fix/spmt"
  },
  {
    id: "fly-machine-rotator",
    label: "Fly Machine Rotator / MountainView",
    repoUrl: "https://github.com/Mtman1987/fly-machine-rotator.git",
    cloneDirName: "fly-machine-rotator",
    appNames: ["mtman-machine-rotator", "mountainview"],
    checkCommands: ["npm run typecheck", "npm test", "npm run build"],
    installCommand: "npm install --include=dev --no-audit --no-fund",
    branchPrefix: "rotator-fix/rotator"
  },
  {
    id: "chat-tag",
    label: "Chat Tag",
    repoUrl: "https://github.com/Mtman1987/chat-tag.git",
    cloneDirName: "chat-tag",
    appNames: ["chat-tag-bot-new", "chat-tag-new"],
    checkCommands: ["npm run typecheck"],
    installCommand: "npm install --include=dev --no-audit --no-fund",
    branchPrefix: "rotator-fix/chat-tag"
  },
  {
    id: "discord-stream-hub",
    label: "Discord Stream Hub",
    repoUrl: "https://github.com/Mtman1987/DiscordStreamHub.git",
    cloneDirName: "discord-stream-hub",
    appNames: ["discord-stream-hub-new", "dsh-clip-worker"],
    checkCommands: ["npm run typecheck"],
    installCommand: "npm install --include=dev --no-audit --no-fund",
    branchPrefix: "rotator-fix/dsh"
  },
  {
    id: "hearmeout",
    label: "HearMeOut",
    repoUrl: "https://github.com/Mtman1987/hearmeout-main.git",
    cloneDirName: "hearmeout-main",
    appNames: ["hearmeout-main", "hmo-dj-worker"],
    checkCommands: ["npm run typecheck"],
    installCommand: "npm install --include=dev --no-audit --no-fund",
    branchPrefix: "rotator-fix/hearmeout"
  },
  {
    id: "streamweaver",
    label: "StreamWeaver",
    repoUrl: "https://github.com/Mtman1987/streamweaver.git",
    cloneDirName: "streamweaver",
    appNames: ["streamweaver-new"],
    checkCommands: [
      "npm run typecheck",
      "npm run test:isolation"
    ],
    installCommand: "npm install --include=dev --no-audit --no-fund",
    branchPrefix: "rotator-fix/streamweaver"
  }
];

export function getRepoConfigForApp(appName: string): RepoConfig | undefined {
  return REPOS.find((repo) => repo.appNames.includes(appName));
}

export function listRepoConfigs(): RepoConfig[] {
  return [...REPOS];
}
