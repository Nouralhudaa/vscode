/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename, dirname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { localize } from '../../../../../nls.js';
import { getFlatContextMenuActions } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { FileKind, IFileService } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { ResourceLabels } from '../../../../browser/labels.js';
import { ResourceContextKey } from '../../../../common/contextkeys.js';
import { ChatAttachmentModel } from '../chatAttachmentModel.js';

/**
 * TODO: @legomushroom - list
 *
 *  - make the prompt instructions attachment persistent
 *  - change attached instructions file icon
 *  - update the attachment model when errorCondition property is set
 *  - add error states for the referenced files
 *  - try different orders of prompt snippet inputs
 */

const INSTRUCTIONS_FOLDER_NAME = '.copilot/instructions';
const INSTRUCTIONS_FILE_EXTENSION = '.md';

export class PromptInstructionsFileReader {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) { }

	public async listFiles(): Promise<readonly URI[]> {
		const locations = this.getSourceLocations();

		const result = await this.findInstructionsFiles(locations);

		return result;
	}

	private getSourceLocations(): readonly URI[] {
		const state = this.workspaceService.getWorkbenchState();

		if (state === WorkbenchState.EMPTY) {
			return [];
		}

		const { folders } = this.workspaceService.getWorkspace();
		return folders.map((folder) => {
			return URI.joinPath(folder.uri, INSTRUCTIONS_FOLDER_NAME);
		});
	}

	private async findInstructionsFiles(
		locations: readonly URI[],
	): Promise<readonly URI[]> {
		const results = await this.fileService.resolveAll(
			locations.map((location) => {
				return { resource: location };
			}),
		);

		const files = [];
		for (const result of results) {
			const { stat, success } = result;

			if (!success) {
				continue;
			}

			if (!stat || !stat.children) {
				continue;
			}

			for (const child of stat.children) {
				const { name, resource, isDirectory } = child;

				// TODO: @legomushroom - filter out `symlinks` too?
				if (isDirectory) {
					continue;
				}

				if (!name.endsWith(INSTRUCTIONS_FILE_EXTENSION)) {
					continue;
				}

				files.push(resource);
			}
		}

		return files;

	}
}

export class PromptInstructionsAttachmentWidget extends Disposable {
	public readonly domNode: HTMLElement;

	private readonly renderDisposables = this._register(new DisposableStore());

	private _onEnabledStateChange = new Emitter<void>();
	readonly onEnabledStateChange = this._onEnabledStateChange.event;

	private _enabled = true;
	private _uri?: URI;

	public get visible(): boolean {
		return !!this._uri;
	}

	public toggle(): this {
		this._enabled = !this._enabled;
		this._onEnabledStateChange.fire();

		this.render();

		return this;
	}

	public get references(): readonly URI[] {
		const { promptInstructions } = this.attachmentsModel;
		if (!promptInstructions) {
			return [];
		}

		return [
			...promptInstructions.validFileReferenceUris,
			promptInstructions.uri,
		];
	}

	constructor(
		private readonly attachmentsModel: ChatAttachmentModel,
		private readonly resourceLabels: ResourceLabels,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IHoverService private readonly hoverService: IHoverService,
		@ILabelService private readonly labelService: ILabelService,
		@IMenuService private readonly menuService: IMenuService,
		@IFileService private readonly fileService: IFileService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IModelService private readonly modelService: IModelService,
	) {
		super();

		this._register(this.attachmentsModel.onDidChangeContext(() => {
			this._uri = this.attachmentsModel.promptInstructions?.uri;

			// TODO: @legomushroom - render only if URI has changed?
			this.render();
		}));

		this.domNode = dom.$('.chat-instructions-attachment.chat-attached-context-attachment.show-file-icons.implicit');
		this.render();
	}

	private render() {
		dom.clearNode(this.domNode);
		this.renderDisposables.clear();

		dom.setVisibility(!!this._uri, this.domNode);

		if (!this._uri) {
			return;
		}

		this.domNode.classList.toggle('disabled', !this._enabled);
		const label = this.resourceLabels.create(this.domNode, { supportIcons: true });
		const file = this._uri;

		const fileBasename = basename(file);
		const fileDirname = dirname(file);
		const friendlyName = `${fileBasename} ${fileDirname}`;
		const ariaLabel = localize('chat.instructionsAttachment', "Prompt instructions attachment, {0}", friendlyName);

		const uriLabel = this.labelService.getUriLabel(file, { relative: true });
		const currentFile = localize('openEditor', "Prompt instructions");
		const inactive = localize('enableHint', "disabled");
		const currentFileHint = currentFile + (this._enabled ? '' : ` (${inactive})`);
		const title = `${currentFileHint}\n${uriLabel}`;
		label.setFile(file, {
			fileKind: FileKind.FILE,
			hidePath: true,
			range: undefined,
			title
		});
		this.domNode.ariaLabel = ariaLabel;
		this.domNode.tabIndex = 0;
		// TODO: @legomushroom - update CSS class-names?
		const hintElement = dom.append(this.domNode, dom.$('span.chat-implicit-hint', undefined, 'Prompt Instructions'));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), hintElement, title));

		// TODO: @legomushroom - update localization keys below
		const toggleButtonMsg = this._enabled ? localize('disable1', "Disable") : localize('enable1', "Enable");
		this.domNode.ariaLabel = toggleButtonMsg; // TODO: @legomushroom - correct the aria lable
		const toggleButton = this.renderDisposables.add(new Button(this.domNode, { supportIcons: true, title: toggleButtonMsg }));
		toggleButton.icon = this._enabled ? Codicon.eye : Codicon.eyeClosed;
		this.renderDisposables.add(toggleButton.onDidClick((e) => {
			e.stopPropagation();
			this.toggle();
		}));

		const removeButton = this.renderDisposables.add(new Button(this.domNode, { supportIcons: true, title: localize('remove', "Remove") }));
		removeButton.icon = Codicon.x;
		this.renderDisposables.add(removeButton.onDidClick((e) => {
			e.stopPropagation();
			this.attachmentsModel.removePromptInstructions();
		}));

		// Context menu
		const scopedContextKeyService = this.renderDisposables.add(this.contextKeyService.createScoped(this.domNode));

		const resourceContextKey = this.renderDisposables.add(new ResourceContextKey(scopedContextKeyService, this.fileService, this.languageService, this.modelService));
		resourceContextKey.set(file);

		this.renderDisposables.add(dom.addDisposableListener(this.domNode, dom.EventType.CONTEXT_MENU, async domEvent => {
			const event = new StandardMouseEvent(dom.getWindow(domEvent), domEvent);
			dom.EventHelper.stop(domEvent, true);

			this.contextMenuService.showContextMenu({
				contextKeyService: scopedContextKeyService,
				getAnchor: () => event,
				getActions: () => {
					const menu = this.menuService.getMenuActions(MenuId.ChatInputResourceAttachmentContext, scopedContextKeyService, { arg: file });
					return getFlatContextMenuActions(menu);
				},
			});
		}));
	}
}
