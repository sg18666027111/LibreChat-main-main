import { Schema } from 'mongoose';
import type { IImagePromptTemplateDocument } from '~/types/imagePromptTemplate';

const imagePromptTemplateSchema: Schema<IImagePromptTemplateDocument> = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    exampleImage: {
      type: new Schema(
        {
          id: { type: String, required: true },
          source: { type: String, required: true },
          filepath: { type: String, required: true },
          storageKey: String,
          type: { type: String, enum: ['image/png', 'image/jpeg', 'image/webp'], required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    category: {
      type: String,
      enum: ['batch_packaging'],
      required: true,
      index: true,
    },
    templateRole: {
      type: String,
      enum: ['global_business', 'packaging_style'],
    },
    taskType: {
      type: String,
      enum: ['text_to_image', 'image_to_image', 'batch_packaging'],
      default: 'batch_packaging',
    },
    prompt: {
      type: String,
      required: true,
      trim: true,
    },
    defaultPrompt: {
      type: String,
      trim: true,
      default: '',
    },
    formattedPrompt: {
      type: String,
      default: '',
    },
    activePromptSource: {
      type: String,
      enum: ['original', 'formatted'],
      default: 'original',
    },
    formatWarnings: {
      type: [String],
      default: [],
    },
    formattedAt: {
      type: Date,
    },
    formattedBy: {
      type: String,
      trim: true,
      default: '',
    },
    platform: {
      type: String,
      trim: true,
      default: '',
    },
    imageType: {
      type: String,
      trim: true,
      default: '',
    },
    isSystem: {
      type: Boolean,
      default: false,
      index: true,
    },
    isEnabled: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    createdBy: {
      type: String,
      trim: true,
      default: '',
    },
    updatedBy: {
      type: String,
      trim: true,
      default: '',
    },
  },
  {
    timestamps: true,
  },
);

imagePromptTemplateSchema.index({ category: 1, sortOrder: 1, createdAt: 1 });
imagePromptTemplateSchema.index({ category: 1, isEnabled: 1, sortOrder: 1 });

export default imagePromptTemplateSchema;
