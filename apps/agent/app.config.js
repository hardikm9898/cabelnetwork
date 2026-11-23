// Build-time additions on top of app.json.
//
// Internal-network builds (EXPO_PUBLIC_ALLOW_HTTP=true) talk to a plain http:// server such as
// http://10.50.0.201:6600. Android blocks cleartext traffic by default; it is allowed only when
// the build explicitly asks for it. Public builds use https:// and keep it blocked.
module.exports = ({ config }) => {
  const allowHttp = process.env.EXPO_PUBLIC_ALLOW_HTTP === 'true';
  const plugins = (config.plugins ?? []).filter((p) => p !== 'expo-build-properties' && !(Array.isArray(p) && p[0] === 'expo-build-properties'));
  plugins.push(['expo-build-properties', { android: { usesCleartextTraffic: allowHttp } }]);
  return { ...config, plugins };
};
