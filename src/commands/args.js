export function option(args, name, { required = true } = {}) {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (required && (!value || value.startsWith('--'))) throw new Error(`--${name} is required`);
  return value;
}
