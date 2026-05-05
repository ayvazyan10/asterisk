// Bash safety checks — detect dangerous commands and leaked secrets before execution.

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+).*\//, reason: 'forced recursive delete on path with /' },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|rf|fr)\b/, reason: 'rm -rf detected' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'writing directly to block device' },
  { pattern: /\bmkfs\b/, reason: 'filesystem format command' },
  { pattern: /\bdd\b.*\bof=\/dev\//, reason: 'dd writing to device' },
  { pattern: /:(){ :|:& };:/, reason: 'fork bomb' },
  { pattern: /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?[0-7]*777\s+\/(?!\w)/, reason: 'chmod 777 on root' },
  { pattern: /\bchown\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?\S+\s+\/(?!\w)/, reason: 'chown on root directory' },
  { pattern: />\s*\/etc\/passwd\b/, reason: 'overwriting /etc/passwd' },
  { pattern: />\s*\/etc\/shadow\b/, reason: 'overwriting /etc/shadow' },
  { pattern: /\bcurl\b.*\|\s*(sudo\s+)?bash\b/, reason: 'piping curl output to bash' },
  { pattern: /\bwget\b.*\|\s*(sudo\s+)?bash\b/, reason: 'piping wget output to bash' },
  { pattern: /\b(shutdown|reboot|poweroff|halt)\b/, reason: 'system shutdown/reboot command' },
  { pattern: /\bsudo\s+rm\b/, reason: 'sudo rm — elevated deletion' },
];

const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/, label: 'API key' },
  { pattern: /\b(ghp_[a-zA-Z0-9]{36,})\b/, label: 'GitHub token' },
  { pattern: /\b(xox[bpsa]-[a-zA-Z0-9-]{10,})\b/, label: 'Slack token' },
  { pattern: /\bAIza[a-zA-Z0-9_-]{35}\b/, label: 'Google API key' },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/, label: 'AWS access key' },
];

export interface SafetyResult {
  safe: boolean;
  warnings: string[];
}

export function checkBashSafety(command: string): SafetyResult {
  const warnings: string[] = [];

  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      warnings.push(`dangerous: ${reason}`);
    }
  }

  for (const { pattern, label } of SECRET_PATTERNS) {
    if (pattern.test(command)) {
      warnings.push(`potential ${label} in command arguments`);
    }
  }

  return { safe: warnings.length === 0, warnings };
}
