const accessPermissions = require('./accessPermissions');
const assistants = require('./assistants');
const categories = require('./categories');
const adminAuth = require('./admin/auth');
const adminAnnouncements = require('./admin/announcements');
const adminConfig = require('./admin/config');
const adminGrants = require('./admin/grants');
const adminGroups = require('./admin/groups');
const adminImageGeneration = require('./admin/imageGeneration');
const adminInviteCodes = require('./admin/inviteCodes');
const adminPromptTemplatePermissions = require('./admin/promptTemplatePermissions');
const adminRoles = require('./admin/roles');
const adminUsage = require('./admin/usage');
const adminUsers = require('./admin/users');
const endpoints = require('./endpoints');
const imageGeneration = require('./imageGeneration');
const announcement = require('./announcement');
const llmAssistant = require('./llmAssistant');
const batchImageGeneration = require('./batchImageGeneration');
const retiredFeatures = require('./retiredFeatures');
const skuGeneration = require('./skuGeneration');
const staticRoute = require('./static');
const messages = require('./messages');
const memories = require('./memories');
const presets = require('./presets');
const prompts = require('./prompts');
const skills = require('./skills');
const balance = require('./balance');
const actions = require('./actions');
const apiKeys = require('./apiKeys');
const banner = require('./banner');
const search = require('./search');
const models = require('./models');
const convos = require('./convos');
const config = require('./config');
const agents = require('./agents');
const roles = require('./roles');
const oauth = require('./oauth');
const files = require('./files');
const share = require('./share');
const tags = require('./tags');
const auth = require('./auth');
const keys = require('./keys');
const user = require('./user');
const mcp = require('./mcp');
const rum = require('./rum');

module.exports = {
  rum,
  mcp,
  auth,
  adminAuth,
  adminAnnouncements,
  adminConfig,
  adminGrants,
  adminGroups,
  adminImageGeneration,
  adminInviteCodes,
  adminPromptTemplatePermissions,
  adminRoles,
  adminUsage,
  adminUsers,
  keys,
  apiKeys,
  user,
  tags,
  roles,
  oauth,
  files,
  share,
  banner,
  agents,
  convos,
  search,
  config,
  models,
  prompts,
  skills,
  actions,
  presets,
  balance,
  messages,
  memories,
  endpoints,
  imageGeneration,
  announcement,
  llmAssistant,
  batchImageGeneration,
  retiredFeatures,
  skuGeneration,
  assistants,
  categories,
  staticRoute,
  accessPermissions,
};
