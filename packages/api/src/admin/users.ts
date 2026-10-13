import { Types } from 'mongoose';
import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import { logger, isValidObjectIdString } from '@librechat/data-schemas';
import type { IUser, IConfig, UserDeleteResult } from '@librechat/data-schemas';
import type { FilterQuery } from 'mongoose';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { parsePagination } from './pagination';

const MAX_SEARCH_LENGTH = 200;

const USER_LIST_FIELDS =
  '_id name username email avatar role provider permissions createdAt updatedAt';
type ImagePromptTemplatePermissionUser = IUser & {
  permissions?: {
    imagePromptTemplates?: {
      manage?: boolean;
    };
  };
};

type AdminUserListItem = {
  id: string;
  name: string;
  username: string;
  email: string;
  avatar: string;
  role: string;
  provider: string;
  canManageImagePromptTemplates: boolean;
  createdAt?: string;
  updatedAt?: string;
};

type AdminUserListResponse = {
  users: AdminUserListItem[];
  total: number;
  page: number;
  pageSize: number;
  limit?: number;
  offset?: number;
};

type AdminUserSearchResult = {
  id: string;
  name: string;
  email: string;
  username?: string;
  avatarUrl?: string;
};

type ImagePromptTemplatePermissionLog = {
  _id?: unknown;
  targetUserId: string;
  targetUserEmail?: string;
  targetUserName?: string;
  permission: 'imagePromptTemplates.manage';
  status: 'active' | 'revoked';
  grantedBy: string;
  grantedByEmail?: string;
  grantedAt?: Date;
  revokedBy?: string;
  revokedByEmail?: string;
  revokedAt?: Date;
};

type AdminPromptTemplatePermissionLog = {
  id: string;
  targetUserId: string;
  targetUserName?: string;
  targetUserEmail?: string;
  permission: string;
  status: 'active' | 'revoked';
  grantedBy?: string;
  grantedByEmail?: string;
  grantedAt?: string;
  revokedBy?: string;
  revokedByEmail?: string;
  revokedAt?: string;
};

type AdminPromptTemplatePermissionLogListResponse = {
  records: AdminPromptTemplatePermissionLog[];
  total: number;
  page: number;
  pageSize: number;
};

function hasPromptTemplateManagementPermission(user: ImagePromptTemplatePermissionUser) {
  return user.permissions?.imagePromptTemplates?.manage === true || user.role === SystemRoles.ADMIN;
}

export interface AdminUsersDeps {
  findUsers: (
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
    options?: { limit?: number; offset?: number; sort?: Record<string, 1 | -1> },
  ) => Promise<IUser[]>;
  countUsers: (filter?: FilterQuery<IUser>) => Promise<number>;
  updateUser: (userId: string, updateData: Partial<IUser>) => Promise<IUser | null>;
  grantImagePromptTemplatePermissionLog: (input: {
    targetUserId: string;
    targetUserEmail?: string;
    targetUserName?: string;
    grantedBy: string;
    grantedByEmail?: string;
  }) => Promise<ImagePromptTemplatePermissionLog>;
  revokeImagePromptTemplatePermissionLog: (input: {
    targetUserId: string;
    revokedBy: string;
    revokedByEmail?: string;
  }) => Promise<ImagePromptTemplatePermissionLog | null>;
  listImagePromptTemplatePermissionLogs: (input?: {
    search?: string;
    status?: 'all' | 'active' | 'revoked';
    limit?: number;
    offset?: number;
  }) => Promise<{ records: ImagePromptTemplatePermissionLog[]; total: number }>;
  softDeleteRevokedImagePromptTemplatePermissionLog: (input: {
    recordId: string;
    deletedBy: string;
  }) => Promise<{ deleted: boolean }>;
  /**
   * Thin data-layer delete — removes the User document only.
   * Full cascade of user-owned resources (conversations, messages, files, tokens, etc.)
   * is handled by `UserController.deleteUserController` in the self-delete flow.
   * This admin endpoint currently cascades Config and AclEntries.
   * A future iteration should consolidate the full cascade into a shared service function.
   */
  deleteUserById: (userId: string) => Promise<UserDeleteResult>;
  deleteConfig: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
  ) => Promise<IConfig | null>;
  deleteAclEntries: (filter: {
    principalType: PrincipalType;
    principalId: string | Types.ObjectId;
  }) => Promise<void>;
}

export function createAdminUsersHandlers(deps: AdminUsersDeps) {
  const {
    findUsers,
    countUsers,
    updateUser,
    grantImagePromptTemplatePermissionLog,
    revokeImagePromptTemplatePermissionLog,
    listImagePromptTemplatePermissionLogs,
    softDeleteRevokedImagePromptTemplatePermissionLog,
    deleteUserById,
    deleteConfig,
    deleteAclEntries,
  } = deps;

  function parsePageParams(query: ServerRequest['query']) {
    const fallback = parsePagination(query);
    const rawPage = typeof query.page === 'string' ? parseInt(query.page, 10) : undefined;
    const rawPageSize =
      typeof query.pageSize === 'string' ? parseInt(query.pageSize, 10) : undefined;
    const pageSize = Math.min(Math.max(rawPageSize ?? fallback.limit, 1), 200);
    const hasPage = rawPage !== undefined && !Number.isNaN(rawPage);
    const page = Math.max(hasPage ? rawPage : Math.floor(fallback.offset / pageSize) + 1, 1);
    const offset = hasPage ? (page - 1) * pageSize : fallback.offset;
    return { page, pageSize, limit: pageSize, offset };
  }

  function normalizeSearch(value: unknown) {
    return typeof value === 'string' ? value.trim().slice(0, MAX_SEARCH_LENGTH) : '';
  }

  function buildUserSearchFilter(search: string): FilterQuery<IUser> {
    if (!search) {
      return {};
    }
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    return { $or: [{ name: regex }, { email: regex }, { username: regex }] };
  }

  function buildPermissionFilter(permission: unknown): FilterQuery<IUser> {
    if (permission !== 'granted' && permission !== 'not_granted') {
      return {};
    }
    if (permission === 'granted') {
      return {
        $or: [{ role: SystemRoles.ADMIN }, { 'permissions.imagePromptTemplates.manage': true }],
      } as FilterQuery<IUser>;
    }
    return {
      role: { $ne: SystemRoles.ADMIN },
      $or: [
        { 'permissions.imagePromptTemplates.manage': { $ne: true } },
        { permissions: { $exists: false } },
      ],
    } as FilterQuery<IUser>;
  }

  function buildAccountListFilter({
    search,
    permission,
  }: {
    search: string;
    permission: unknown;
  }): FilterQuery<IUser> {
    const filters = [buildUserSearchFilter(search), buildPermissionFilter(permission)].filter(
      (filter) => Object.keys(filter).length > 0,
    );
    if (filters.length === 0) {
      return {};
    }
    if (filters.length === 1) {
      return filters[0];
    }
    return { $and: filters } as FilterQuery<IUser>;
  }

  function mapAdminUser(u: IUser): AdminUserListItem {
    return {
      id: u._id?.toString() ?? '',
      name: u.name ?? '',
      username: u.username ?? '',
      email: u.email ?? '',
      avatar: u.avatar ?? '',
      role: u.role ?? 'USER',
      provider: u.provider ?? 'local',
      canManageImagePromptTemplates: hasPromptTemplateManagementPermission(
        u as ImagePromptTemplatePermissionUser,
      ),
      createdAt: u.createdAt?.toISOString(),
      updatedAt: u.updatedAt?.toISOString(),
    };
  }

  function mapPermissionLog(
    record: ImagePromptTemplatePermissionLog,
  ): AdminPromptTemplatePermissionLog {
    return {
      id: record._id ? String(record._id) : '',
      targetUserId: record.targetUserId,
      targetUserName: record.targetUserName ?? '',
      targetUserEmail: record.targetUserEmail ?? '',
      permission: record.permission,
      status: record.status,
      grantedBy: record.grantedBy,
      grantedByEmail: record.grantedByEmail ?? '',
      grantedAt: record.grantedAt?.toISOString(),
      revokedBy: record.revokedBy ?? '',
      revokedByEmail: record.revokedByEmail ?? '',
      revokedAt: record.revokedAt?.toISOString(),
    };
  }

  function getActor(req: ServerRequest) {
    return {
      id: req.user?._id?.toString() ?? req.user?.id ?? '',
      email: req.user?.email ?? '',
    };
  }

  async function getTargetUser(id: string) {
    if (!isValidObjectIdString(id)) {
      return { status: 400, error: 'Invalid user ID format' as const, user: null };
    }
    const [targetUser] = await findUsers({ _id: id }, USER_LIST_FIELDS, { limit: 1 });
    if (!targetUser) {
      return { status: 404, error: 'User not found' as const, user: null };
    }
    return { status: 200, error: null, user: targetUser };
  }

  async function listUsersHandler(req: ServerRequest, res: Response) {
    try {
      const { page, pageSize, limit, offset } = parsePageParams(req.query);
      const search = normalizeSearch(req.query.search);
      const filter = buildAccountListFilter({ search, permission: req.query.permission });
      const countPromise = Object.keys(filter).length === 0 ? countUsers() : countUsers(filter);
      const [users, total] = await Promise.all([
        findUsers(filter, USER_LIST_FIELDS, { limit, offset, sort: { createdAt: -1 } }),
        countPromise,
      ]);

      const mapped: AdminUserListItem[] = users.map(mapAdminUser);

      const response: AdminUserListResponse = {
        users: mapped,
        total,
        page,
        pageSize,
        limit,
        offset,
      };

      return res.status(200).json(response);
    } catch (error) {
      logger.error('[adminUsers] listUsers error:', error);
      return res.status(500).json({ error: 'Failed to list users' });
    }
  }

  async function searchUsersHandler(req: ServerRequest, res: Response) {
    try {
      const rawQ = req.query.q;
      const rawLimit = req.query.limit;
      const query = typeof rawQ === 'string' ? rawQ : undefined;
      const limitStr = typeof rawLimit === 'string' ? rawLimit : '20';
      const trimmed = query?.trim() ?? '';

      if (!trimmed) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }

      if (trimmed.length < 2) {
        return res.status(400).json({ error: 'Query must be at least 2 characters' });
      }

      if (trimmed.length > MAX_SEARCH_LENGTH) {
        return res
          .status(400)
          .json({ error: `Query must not exceed ${MAX_SEARCH_LENGTH} characters` });
      }

      const searchLimit = Math.min(Math.max(1, parseInt(limitStr, 10) || 20), 50);
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escaped}`, 'i');

      const users = await findUsers(
        { $or: [{ name: regex }, { email: regex }, { username: regex }] },
        '_id name email username avatar',
        { limit: searchLimit, sort: { name: 1 } },
      );

      const results: AdminUserSearchResult[] = users.map((u) => ({
        id: u._id?.toString() ?? '',
        name: u.name ?? '',
        email: u.email ?? '',
        username: u.username,
        avatarUrl: u.avatar,
      }));

      return res
        .status(200)
        .json({ users: results, total: results.length, capped: results.length >= searchLimit });
    } catch (error) {
      logger.error('[adminUsers] searchUsers error:', error);
      return res.status(500).json({ error: 'Failed to search users' });
    }
  }

  async function deleteUserHandler(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as { id: string };

      if (!isValidObjectIdString(id)) {
        return res.status(400).json({ error: 'Invalid user ID format' });
      }

      const callerId = req.user?._id?.toString() ?? req.user?.id;
      if (callerId === id) {
        return res.status(403).json({ error: 'Cannot delete your own account' });
      }

      const [targetUser] = await findUsers({ _id: id }, 'role', { limit: 1 });
      if (targetUser?.role === SystemRoles.ADMIN) {
        const adminCount = await countUsers({ role: SystemRoles.ADMIN });
        if (adminCount <= 1) {
          return res.status(400).json({ error: 'Cannot delete the last admin user' });
        }
      }

      const result = await deleteUserById(id);

      if (result.deletedCount === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (targetUser?.role === SystemRoles.ADMIN) {
        const remaining = await countUsers({ role: SystemRoles.ADMIN });
        if (remaining === 0) {
          logger.error(
            `[adminUsers] CRITICAL: last admin deleted via race condition, user: ${id}. ` +
              'Manual DB intervention required to restore an ADMIN user.',
          );
        }
      }

      const objectId = new Types.ObjectId(id);
      const cleanupResults = await Promise.allSettled([
        deleteConfig(PrincipalType.USER, id),
        deleteAclEntries({ principalType: PrincipalType.USER, principalId: objectId }),
      ]);
      for (const r of cleanupResults) {
        if (r.status === 'rejected') {
          logger.error('[adminUsers] cascade cleanup failed for user:', id, r.reason);
        }
      }

      return res.status(200).json({ message: result.message || 'User deleted successfully' });
    } catch (error) {
      logger.error('[adminUsers] deleteUser error:', error);
      return res.status(500).json({ error: 'Failed to delete user' });
    }
  }

  async function updatePermissionsHandler(req: ServerRequest, res: Response) {
    try {
      const body = req.body as { canManageImagePromptTemplates?: boolean };
      const canManageImagePromptTemplates = body.canManageImagePromptTemplates === true;

      if (!canManageImagePromptTemplates) {
        return revokePromptTemplatePermissionHandler(req, res);
      }
      return grantPromptTemplatePermissionHandler(req, res);
    } catch (error) {
      logger.error('[adminUsers] updatePermissions error:', error);
      return res.status(500).json({ error: 'Failed to update user permissions' });
    }
  }

  async function grantPromptTemplatePermissionHandler(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as { id: string };
      const target = await getTargetUser(id);
      if (!target.user) {
        return res.status(target.status).json({ error: target.error });
      }

      const actor = getActor(req);
      const updated = await updateUser(id, {
        'permissions.imagePromptTemplates.manage': true,
      } as Partial<IUser>);

      if (!updated) {
        return res.status(404).json({ error: 'User not found' });
      }

      let record: ImagePromptTemplatePermissionLog | null = null;
      if (target.user.role !== SystemRoles.ADMIN) {
        record = await grantImagePromptTemplatePermissionLog({
          targetUserId: id,
          targetUserEmail: target.user.email ?? '',
          targetUserName: target.user.name ?? target.user.username ?? '',
          grantedBy: actor.id,
          grantedByEmail: actor.email,
        });
      }

      return res.status(200).json({
        user: mapAdminUser(updated),
        record: record ? mapPermissionLog(record) : null,
      });
    } catch (error) {
      logger.error('[adminUsers] grantPromptTemplatePermission error:', error);
      return res.status(500).json({ error: 'Failed to update user permissions' });
    }
  }

  async function revokePromptTemplatePermissionHandler(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as { id: string };
      const target = await getTargetUser(id);
      if (!target.user) {
        return res.status(target.status).json({ error: target.error });
      }
      if (target.user.role === SystemRoles.ADMIN) {
        return res.status(403).json({ error: '管理员默认拥有该权限，不能取消' });
      }

      const actor = getActor(req);
      const updated = await updateUser(id, {
        'permissions.imagePromptTemplates.manage': false,
      } as Partial<IUser>);

      if (!updated) {
        return res.status(404).json({ error: 'User not found' });
      }

      const record = await revokeImagePromptTemplatePermissionLog({
        targetUserId: id,
        revokedBy: actor.id,
        revokedByEmail: actor.email,
      });

      return res.status(200).json({
        user: mapAdminUser(updated),
        record: record ? mapPermissionLog(record) : null,
      });
    } catch (error) {
      logger.error('[adminUsers] revokePromptTemplatePermission error:', error);
      return res.status(500).json({ error: 'Failed to update user permissions' });
    }
  }

  async function listPromptTemplatePermissionLogsHandler(req: ServerRequest, res: Response) {
    try {
      const { page, pageSize, limit, offset } = parsePageParams(req.query);
      const status =
        req.query.status === 'active' || req.query.status === 'revoked' ? req.query.status : 'all';
      const search = normalizeSearch(req.query.search);
      const result = await listImagePromptTemplatePermissionLogs({
        search,
        status,
        limit,
        offset,
      });

      const response: AdminPromptTemplatePermissionLogListResponse = {
        records: result.records.map(mapPermissionLog),
        total: result.total,
        page,
        pageSize,
      };

      return res.status(200).json(response);
    } catch (error) {
      logger.error('[adminUsers] listPromptTemplatePermissionLogs error:', error);
      return res.status(500).json({ error: 'Failed to list permission records' });
    }
  }

  async function deletePromptTemplatePermissionLogHandler(req: ServerRequest, res: Response) {
    try {
      const { recordId } = req.params as { recordId: string };
      if (!isValidObjectIdString(recordId)) {
        return res.status(400).json({ error: 'Invalid record ID format' });
      }

      const actor = getActor(req);
      const result = await softDeleteRevokedImagePromptTemplatePermissionLog({
        recordId,
        deletedBy: actor.id,
      });
      return res.status(200).json(result);
    } catch (error) {
      logger.error('[adminUsers] deletePromptTemplatePermissionLog error:', error);
      const message = error instanceof Error ? error.message : 'Failed to delete permission record';
      const status = message.includes('不能删除') ? 400 : 500;
      return res.status(status).json({ error: message });
    }
  }

  return {
    listUsers: listUsersHandler,
    searchUsers: searchUsersHandler,
    updatePermissions: updatePermissionsHandler,
    grantPromptTemplatePermission: grantPromptTemplatePermissionHandler,
    revokePromptTemplatePermission: revokePromptTemplatePermissionHandler,
    listPromptTemplatePermissionLogs: listPromptTemplatePermissionLogsHandler,
    deletePromptTemplatePermissionLog: deletePromptTemplatePermissionLogHandler,
    deleteUser: deleteUserHandler,
  };
}
