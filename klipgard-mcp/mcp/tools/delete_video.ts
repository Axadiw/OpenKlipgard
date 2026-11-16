import { getUserByInternalId } from '../../../server/db/queries/users.js';
import { deleteEventOwned } from '../../../server/services/eventDeletion.js';
import { writeAuditLog } from '../../db/queries.js';
import type { McpAuthContext } from '../bearerAuth.js';

export interface DeleteVideoInput {
  id: string;
  confirm: boolean;
}

export interface DeleteVideoOutput {
  deleted: true;
  id: string;
}

export const deleteVideoToolDescriptor = {
  name: 'delete_video',
  description:
    'Permanently delete a video. Requires confirm:true as an explicit LLM safeguard. This action is irreversible. Fails with not_found when no such recording exists.',
  inputSchema: {
    type: 'object' as const,
    required: ['id', 'confirm'],
    properties: {
      id: { type: 'string', description: 'Event ID of the video to delete.' },
      confirm: {
        type: 'boolean',
        description: 'Must be exactly true. Protects against accidental deletion.',
      },
    },
  },
} as const;

export async function deleteVideoImpl(
  input: DeleteVideoInput,
  auth: McpAuthContext,
): Promise<DeleteVideoOutput> {
  // 1. Scope gate
  if (!auth.scope.split(/\s+/).includes('videos:delete')) {
    throw new Error('insufficient_scope');
  }

  // 2. Confirm guard — must be literally true (not just truthy)
  if (input.confirm !== true) {
    throw new Error('confirm:true required to delete');
  }

  // 3. Delete through the same cascade the web uses (S3 objects, file_metadata,
  //    quota usage, thumbnail); an unknown or foreign id is not_found.
  const user = await getUserByInternalId(auth.userId);
  if (!user) {
    throw new Error('user_not_found');
  }
  const result = await deleteEventOwned(input.id, auth.userId, user.id);
  if (result === 'not_found') {
    throw new Error('not_found');
  }

  // 4. Audit log
  await writeAuditLog({
    userId: auth.userId,
    clientId: auth.clientId,
    action: 'tool.delete_video',
    detailsJson: { event_id: input.id },
    ip: null,
  });

  return { deleted: true, id: input.id };
}
