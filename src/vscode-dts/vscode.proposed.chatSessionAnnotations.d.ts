/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// Annotations on a chat session's timeline, e.g. progress digests written while it ran.

	/**
	 * How much an annotation asks for attention.
	 */
	export enum ChatSessionAnnotationEmphasis {
		/**
		 * An update to read when convenient.
		 */
		Normal = 1,
		/**
		 * The session needs the user, or is blocked or off course.
		 */
		Attention = 2
	}

	/**
	 * A note at a moment of a chat session, shown on its prompt timeline between the prompts
	 * sent before and after it.
	 */
	export interface ChatSessionAnnotation {
		/**
		 * Unique among this extension's annotations on the session.
		 */
		readonly id: string;
		/**
		 * When the note was written, in milliseconds since the epoch: it follows the session's
		 * requests made before then.
		 */
		readonly timestamp: number;
		/**
		 * A one-line summary.
		 */
		readonly label: string;
		/**
		 * The note in full, shown when it is expanded. Command links run only when the string is
		 * trusted for them.
		 */
		readonly detail?: MarkdownString;
		readonly icon?: ThemeIcon;
		readonly emphasis?: ChatSessionAnnotationEmphasis;
	}

	export namespace chat {
		/**
		 * Replaces this extension's annotations on a session's timeline.
		 *
		 * @param session The session's resource.
		 * @param annotations The annotations; an empty array removes them.
		 */
		export function setChatSessionAnnotations(session: Uri, annotations: readonly ChatSessionAnnotation[]): void;
	}
}
