/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAzureParentTreeItem, IAzureTreeItem } from '../../index';
import { NotImplementedError } from '../errors';
import { IUserInterface, PickWithData } from '../IUserInterface';
import { localize } from '../localize';
import { AzureNode, IAzureParentNodeInternal } from './AzureNode';
import { CreatingTreeItem } from './CreatingTreeItem';
import { LoadMoreTreeItem } from './LoadMoreTreeItem';

export class AzureParentNode<T extends IAzureParentTreeItem = IAzureParentTreeItem> extends AzureNode<T> implements IAzureParentNodeInternal {
    private _cachedChildren: AzureNode[] | undefined;
    private _creatingNodes: AzureNode[] = [];

    public async getCachedChildren(): Promise<AzureNode[]> {
        if (this._cachedChildren === undefined) {
            await this.loadMoreChildren();
        }

        return this._cachedChildren ? this._cachedChildren : [];
    }

    public get creatingNodes(): AzureNode[] {
        return this._creatingNodes;
    }

    public clearCache(): void {
        this._cachedChildren = undefined;
    }

    public async createChild(userOptions?: {}): Promise<AzureNode> {
        if (this.treeItem.createChild) {
            let creatingNode: AzureNode | undefined;
            try {
                const newTreeItem: IAzureTreeItem = await this.treeItem.createChild(
                    this,
                    (label: string): void => {
                        creatingNode = new AzureNode(this, new CreatingTreeItem(label));
                        this._creatingNodes.push(creatingNode);
                        //tslint:disable-next-line:no-floating-promises
                        this.treeDataProvider.refresh(this, false);
                    },
                    userOptions);

                const newNode: AzureNode = this.createNewNode(newTreeItem);
                await this.addNodeToCache(newNode);
                return newNode;
            } finally {
                if (creatingNode) {
                    this._creatingNodes.splice(this._creatingNodes.indexOf(creatingNode), 1);
                    await this.treeDataProvider.refresh(this, false);
                }
            }
        } else {
            throw new NotImplementedError('createChild', this.treeItem);
        }
    }

    public async loadMoreChildren(): Promise<void> {
        let clearCache: boolean = false;
        if (this._cachedChildren === undefined) {
            this._cachedChildren = [];
            clearCache = true;
        }

        const newTreeItems: IAzureTreeItem[] = await this.treeItem.loadMoreChildren(this, clearCache);
        this._cachedChildren = this._cachedChildren
            .concat(newTreeItems.map((t: IAzureTreeItem) => this.createNewNode(t)))
            .sort((n1: AzureNode, n2: AzureNode) => n1.treeItem.label.localeCompare(n2.treeItem.label));
    }

    public async pickChildNode(expectedContextValues: string[], ui: IUserInterface): Promise<AzureNode> {
        if (this.treeItem.pickTreeItem) {
            const children: AzureNode[] = await this.getCachedChildren();
            for (const val of expectedContextValues) {
                const pickedItem: IAzureTreeItem | undefined = this.treeItem.pickTreeItem(val);
                if (pickedItem) {
                    const node: AzureNode | undefined = children.find((n: AzureNode) => {
                        return (!!pickedItem.id && n.treeItem.id === pickedItem.id) || (n.treeItem.label === pickedItem.label);
                    });
                    if (node) {
                        return node;
                    }
                }
            }
        }

        const pick: PickWithData<GetNodeFunction> = await ui.showQuickPick<GetNodeFunction>(this.getQuickPicks(expectedContextValues), localize('selectNode', 'Select a {0}', this.treeItem.childTypeLabel), true /* ignoreFocusOut */);
        return await pick.data();
    }

    public async addNodeToCache(node: AzureNode): Promise<void> {
        if (this._cachedChildren) {
            // set index to the last element by default
            let index: number = this._cachedChildren.length;
            // tslint:disable-next-line:no-increment-decrement
            for (let i: number = 0; i < this._cachedChildren.length; i++) {
                if (node.treeItem.label.localeCompare(this._cachedChildren[i].treeItem.label) < 1) {
                    index = i;
                    break;
                }
            }
            this._cachedChildren.splice(index, 0, node);
            await this.treeDataProvider.refresh(this, false);
        }
    }

    public async removeNodeFromCache(node: AzureNode): Promise<void> {
        if (this._cachedChildren) {
            const index: number = this._cachedChildren.indexOf(node);
            if (index !== -1) {
                this._cachedChildren.splice(index, 1);
                await this.treeDataProvider.refresh(this, false);
            }
        }
    }

    private async getQuickPicks(expectedContextValues: string[]): Promise<PickWithData<GetNodeFunction>[]> {
        let nodes: AzureNode[] = await this.getCachedChildren();
        nodes = nodes.filter((node: AzureNode) => node.includeInNodePicker(expectedContextValues));

        const picks: PickWithData<GetNodeFunction>[] = nodes.map((n: AzureNode) => new PickWithData(async (): Promise<AzureNode> => await Promise.resolve(n), n.treeItem.label));
        if (this.treeItem.createChild && this.treeItem.childTypeLabel) {
            picks.unshift(new PickWithData<GetNodeFunction>(
                async (): Promise<AzureNode> => await this.createChild(),
                localize('nodePickerCreateNew', '$(plus) Create New {0}', this.treeItem.childTypeLabel)
            ));
        }

        if (this.treeItem.hasMoreChildren()) {
            picks.push(new PickWithData<GetNodeFunction>(
                async (): Promise<AzureNode> => {
                    await this.loadMoreChildren();
                    await this.treeDataProvider.refresh(this, false);
                    return this;
                },
                LoadMoreTreeItem.label
            ));
        }

        return picks;
    }

    private createNewNode(treeItem: IAzureTreeItem): AzureNode {
        const parentTreeItem: IAzureParentTreeItem = <IAzureParentTreeItem>treeItem;
        // tslint:disable-next-line:strict-boolean-expressions
        if (parentTreeItem.loadMoreChildren) {
            return new AzureParentNode(this, parentTreeItem);
        } else {
            return new AzureNode(this, treeItem);
        }
    }
}

type GetNodeFunction<T extends IAzureTreeItem = IAzureTreeItem> = () => Promise<AzureNode<T>>;
