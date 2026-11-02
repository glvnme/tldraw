import {
	DefaultContextMenu,
	DefaultContextMenuContent,
	TLUiContextMenuProps,
	TldrawUiMenuActionItem,
	TldrawUiMenuGroup,
	useEditor,
	useValue,
} from 'tldraw'
import { getSelectedModel3dShape } from './actions'

export function Model3dContextMenu(props: TLUiContextMenuProps) {
	const editor = useEditor()
	const hasModel = useValue('model3d selected', () => getSelectedModel3dShape(editor) !== null, [
		editor,
	])
	return (
		<DefaultContextMenu {...props}>
			{hasModel && (
				<TldrawUiMenuGroup id="model3d">
					<TldrawUiMenuActionItem actionId="open-in-3d" />
				</TldrawUiMenuGroup>
			)}
			<DefaultContextMenuContent />
		</DefaultContextMenu>
	)
}
