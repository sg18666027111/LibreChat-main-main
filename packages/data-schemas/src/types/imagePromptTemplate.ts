import type { Document, Types } from 'mongoose';

export type ImagePromptTemplateCategory = 'batch_packaging';

export type ImagePromptTemplateRole = 'global_business' | 'packaging_style';

export type ImagePromptTemplateTaskType = 'text_to_image' | 'image_to_image' | 'batch_packaging';

export type ImagePromptTemplateActiveSource = 'original' | 'formatted';

export type ImagePromptTemplateExample = {
  id: string;
  source: string;
  filepath: string;
  storageKey?: string;
  type: 'image/png' | 'image/jpeg' | 'image/webp';
};

export interface IImagePromptTemplate {
  _id: Types.ObjectId;
  key: string;
  name: string;
  description?: string;
  exampleImage?: ImagePromptTemplateExample | null;
  category: ImagePromptTemplateCategory;
  templateRole?: ImagePromptTemplateRole;
  taskType?: ImagePromptTemplateTaskType;
  prompt: string;
  defaultPrompt?: string;
  formattedPrompt?: string;
  activePromptSource?: ImagePromptTemplateActiveSource;
  formatWarnings?: string[];
  formattedAt?: Date;
  formattedBy?: string;
  platform?: string;
  imageType?: string;
  isSystem: boolean;
  isEnabled: boolean;
  sortOrder?: number;
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type IImagePromptTemplateDocument = IImagePromptTemplate & Document;

export type CreateImagePromptTemplateInput = {
  key: string;
  name: string;
  description?: string;
  exampleImage?: ImagePromptTemplateExample | null;
  category: ImagePromptTemplateCategory;
  templateRole?: ImagePromptTemplateRole;
  taskType?: ImagePromptTemplateTaskType;
  prompt: string;
  defaultPrompt?: string;
  formattedPrompt?: string;
  activePromptSource?: ImagePromptTemplateActiveSource;
  formatWarnings?: string[];
  formattedAt?: Date;
  formattedBy?: string;
  platform?: string;
  imageType?: string;
  isSystem?: boolean;
  isEnabled?: boolean;
  sortOrder?: number;
  createdBy?: string;
  updatedBy?: string;
};

export type UpdateImagePromptTemplateInput = Partial<
  Pick<
    IImagePromptTemplate,
    | 'name'
    | 'description'
    | 'exampleImage'
    | 'taskType'
    | 'prompt'
    | 'formattedPrompt'
    | 'activePromptSource'
    | 'formatWarnings'
    | 'formattedAt'
    | 'formattedBy'
    | 'platform'
    | 'imageType'
    | 'isEnabled'
    | 'sortOrder'
    | 'updatedBy'
  >
>;
