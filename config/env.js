function envVar(name) {
  return process.env[name];
}

function requireEnv(name) {
  const value = envVar(name);
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Create a .env file (copy from .env.example) and set it.`
    );
  }
  return value;
}

function requireEnvNumber(name) {
  const raw = requireEnv(name);
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Environment variable ${name} must be a number, got: ${raw}`);
  }
  return n;
}

module.exports = {
  requireEnv,
  requireEnvNumber,
};

