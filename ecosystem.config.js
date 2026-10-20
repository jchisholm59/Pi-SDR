// pm2: pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [{ name: 'pi-sdr', script: 'server.js', cwd: __dirname, env: { PORT: 8073 }, max_restarts: 50, restart_delay: 3000, kill_timeout: 3000 }],
};
