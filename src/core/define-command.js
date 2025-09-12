'use strict';

/**
 * defineCommand(manifest)
 * - name: string (canonical command name)
 * - category: 'static' | 'dynamic' | 'moderator' | string
 * - schemaVersion: number
 * - schema: JSON Schema for this command's config (Ajv compatible)
 * - defaults: object (mirrors schema defaults; used to fill blank values)
 * - async execute(ctx, args, cfg): returns { vars?, reply?, actions?[], suppress? }
 *
 * Actions (optional) are structured side-effects the router can run:
 *   { type: 'announce', message, color? }
 *   { type: 'shoutout', toBroadcasterId }
 *   { type: 'timeout', userId, seconds }
 *   { type: 'delete', messageId }
 *   (extendable later)
 */
module.exports = function defineCommand(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('defineCommand: manifest must be an object');
  }
  if (!manifest.name || typeof manifest.name !== 'string') {
    throw new Error('defineCommand: manifest.name is required');
  }
  if (!manifest.execute || typeof manifest.execute !== 'function') {
    throw new Error(`defineCommand(${manifest.name}): execute(ctx,args,cfg) is required`);
  }
  if (typeof manifest.schemaVersion !== 'number') {
    throw new Error(`defineCommand(${manifest.name}): schemaVersion (number) is required`);
  }
  manifest.category = manifest.category || 'dynamic';
  manifest.defaults = manifest.defaults || {};
  manifest.schema = manifest.schema || { type: 'object', properties: {}, additionalProperties: true };
  return manifest;
};
