const { apps } = require("../../ecosystem.config.cjs");

const names = apps
  .filter((app) => app.autorestart !== false)
  .map((app) => app.name);

process.stdout.write(names.join(","));
