import {
  addUserQuery,
  countUserQueries,
  deleteUserQuery,
  DuplicateQueryError,
  listUserQueries,
  updateUserQuery,
} from '../services/queries/queriesStorage.js';
import { QueryUrlError, validateQueryUrl } from '../queries/url.js';
import { MAX_QUERY_NAME_LENGTH } from '../queries/limits.js';

const nameSchema = { type: 'string', maxLength: MAX_QUERY_NAME_LENGTH };
const idParams = {
  type: 'object',
  properties: { id: { type: 'integer', minimum: 1 } },
  required: ['id'],
};

/**
 * Per-user search queries: `GET/POST /api/queries`, `PUT/DELETE /api/queries/:id`. Everything is scoped by the session
 * user (a query of another user answers 404). Only https://www.wg-gesucht.de search result pages are accepted (see
 * validateQueryUrl), at most `maxPerUser` (config `queries.maxPerUser`, default 1) per user. A change asks the pipeline to evaluate the user's new view.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {{reevaluate: (userId: string, all: boolean) => void, maxPerUser: number}} options
 */
export function registerQueryRoutes(app, { reevaluate, maxPerUser }) {
  app.get('/api/queries', async (request) => ({
    items: listUserQueries(request.user.username),
    max: maxPerUser,
  }));

  app.post(
    '/api/queries',
    {
      schema: {
        body: {
          type: 'object',
          properties: { name: nameSchema, url: { type: 'string' }, enabled: { type: 'boolean' } },
          required: ['url'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.username;
      let url;
      try {
        url = validateQueryUrl(request.body.url);
      } catch (e) {
        if (e instanceof QueryUrlError) return reply.code(400).send({ error: e.message });
        throw e;
      }
      if (countUserQueries(userId) >= maxPerUser) {
        return reply.code(409).send({
          error: `You can have at most ${maxPerUser} ${maxPerUser === 1 ? 'query' : 'queries'} (limit set by the administrator to keep the load on WG-Gesucht low). ${maxPerUser === 1 ? 'Edit or delete your query instead.' : 'Delete one first.'}`,
        });
      }
      const created = addUserQuery(userId, {
        name: (request.body.name ?? '').trim(),
        url,
        enabled: request.body.enabled ?? true,
      });
      if (!created) return reply.code(409).send({ error: new DuplicateQueryError().message });
      reevaluate(userId, false);
      return reply.code(201).send(created);
    },
  );

  app.put(
    '/api/queries/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          properties: { name: nameSchema, url: { type: 'string' }, enabled: { type: 'boolean' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.username;
      const { name, url, enabled } = request.body ?? {};
      let checked;
      try {
        checked = url === undefined ? undefined : validateQueryUrl(url);
      } catch (e) {
        if (e instanceof QueryUrlError) return reply.code(400).send({ error: e.message });
        throw e;
      }
      let updated;
      try {
        updated = updateUserQuery(userId, request.params.id, { name: name?.trim(), url: checked, enabled });
      } catch (e) {
        if (e instanceof DuplicateQueryError) return reply.code(409).send({ error: e.message });
        throw e;
      }
      if (!updated) return reply.code(404).send({ error: 'Query not found' });
      reevaluate(userId, false);
      return updated;
    },
  );

  app.delete('/api/queries/:id', { schema: { params: idParams } }, async (request, reply) => {
    const userId = request.user.username;
    if (!deleteUserQuery(userId, request.params.id)) return reply.code(404).send({ error: 'Query not found' });
    reevaluate(userId, false);
    return { id: request.params.id, deleted: true };
  });
}
