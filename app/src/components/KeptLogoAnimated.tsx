import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const GW = 16, GH = 16;
const TW = 48, TH = 24;
const TEX = new Uint8Array([144, 223, 255, 141, 223, 255, 139, 221, 255, 145, 223, 255, 149, 225, 255, 151, 227, 255, 146, 227, 255, 146, 227, 255, 154, 232, 255, 161, 234, 255, 164, 237, 255, 169, 239, 255, 167, 235, 255, 176, 236, 255, 186, 242, 255, 188, 244, 255, 185, 244, 255, 163, 231, 255, 162, 229, 255, 164, 227, 246, 147, 226, 242, 141, 221, 255, 126, 215, 255, 113, 211, 255, 124, 215, 255, 126, 217, 255, 119, 211, 254, 119, 211, 254, 122, 215, 255, 128, 217, 255, 132, 219, 255, 135, 219, 255, 132, 219, 255, 130, 219, 255, 126, 215, 255, 124, 215, 255, 126, 215, 255, 121, 215, 255, 110, 210, 255, 100, 205, 253, 100, 205, 253, 104, 205, 252, 138, 224, 255, 172, 240, 255, 154, 230, 255, 135, 219, 255, 133, 217, 255, 139, 221, 255, 174, 243, 255, 172, 236, 255, 171, 238, 255, 144, 225, 255, 131, 220, 255, 130, 219, 255, 148, 227, 255, 172, 236, 255, 181, 238, 238, 201, 249, 254, 204, 249, 246, 203, 244, 216, 204, 239, 176, 235, 254, 222, 226, 254, 239, 242, 255, 242, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 217, 221, 252, 224, 213, 255, 255, 159, 229, 255, 159, 231, 255, 196, 246, 255, 219, 255, 255, 221, 255, 255, 221, 255, 255, 214, 255, 255, 219, 255, 255, 230, 255, 255, 230, 255, 255, 225, 255, 255, 242, 255, 255, 225, 255, 255, 200, 245, 231, 175, 233, 205, 169, 232, 225, 180, 240, 255, 172, 236, 255, 169, 236, 255, 188, 245, 255, 216, 255, 255, 225, 255, 255, 208, 253, 255, 190, 245, 255, 185, 245, 255, 220, 252, 245, 239, 255, 255, 203, 244, 216, 157, 219, 183, 165, 219, 194, 170, 228, 224, 171, 237, 225, 188, 237, 181, 180, 226, 141, 169, 223, 138, 179, 235, 182, 176, 226, 154, 174, 225, 137, 198, 239, 188, 194, 238, 209, 193, 247, 255, 235, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 235, 245, 204, 204, 251, 253, 177, 242, 255, 142, 223, 255, 141, 223, 255, 173, 238, 255, 219, 250, 225, 198, 238, 194, 206, 247, 230, 228, 255, 255, 214, 253, 246, 197, 243, 205, 203, 245, 216, 167, 230, 167, 156, 224, 151, 126, 205, 101, 160, 208, 87, 152, 208, 80, 165, 213, 89, 155, 215, 114, 157, 214, 132, 215, 237, 180, 182, 228, 147, 151, 217, 132, 170, 230, 172, 210, 245, 207, 232, 254, 225, 225, 250, 212, 221, 252, 227, 228, 255, 249, 147, 210, 104, 175, 209, 77, 218, 224, 120, 230, 220, 107, 193, 186, 47, 174, 206, 93, 161, 217, 116, 170, 212, 98, 141, 204, 85, 149, 215, 127, 214, 249, 223, 203, 245, 220, 170, 221, 128, 215, 250, 240, 177, 240, 255, 237, 255, 237, 247, 255, 255, 180, 238, 255, 195, 249, 255, 195, 244, 238, 202, 253, 255, 177, 240, 255, 201, 246, 255, 208, 231, 161, 187, 228, 141, 129, 204, 103, 122, 201, 100, 139, 209, 108, 121, 199, 81, 128, 201, 75, 105, 193, 67, 89, 190, 72, 90, 190, 57, 105, 193, 67, 198, 224, 105, 206, 227, 108, 194, 220, 102, 156, 204, 77, 143, 199, 71, 180, 208, 79, 217, 207, 76, 198, 202, 72, 175, 216, 95, 196, 224, 116, 182, 217, 106, 165, 218, 137, 173, 236, 255, 211, 253, 255, 185, 236, 224, 159, 228, 228, 142, 221, 255, 169, 229, 254, 215, 215, 139, 228, 200, 69, 216, 224, 113, 212, 236, 133, 163, 209, 99, 150, 212, 118, 204, 244, 208, 187, 234, 184, 183, 219, 107, 210, 236, 159, 166, 232, 242, 139, 221, 255, 139, 219, 255, 152, 227, 255, 146, 225, 255, 164, 237, 255, 196, 247, 255, 208, 244, 198, 223, 252, 243, 156, 217, 131, 167, 230, 175, 126, 205, 101, 118, 194, 68, 121, 194, 68, 114, 195, 66, 158, 208, 82, 136, 202, 76, 109, 195, 73, 112, 198, 72, 145, 204, 78, 178, 206, 86, 195, 216, 103, 209, 217, 105, 222, 209, 93, 228, 228, 115, 206, 215, 94, 211, 235, 161, 221, 255, 255, 234, 255, 234, 175, 225, 182, 144, 223, 255, 152, 227, 255, 88, 201, 246, 81, 197, 247, 87, 201, 255, 80, 199, 255, 95, 203, 254, 116, 211, 255, 158, 234, 255, 197, 212, 137, 212, 179, 49, 242, 222, 103, 213, 234, 125, 168, 209, 98, 130, 202, 111, 151, 208, 102, 193, 222, 102, 205, 237, 164, 217, 251, 213, 193, 247, 255, 110, 211, 255, 126, 215, 255, 139, 219, 255, 110, 208, 255, 161, 231, 255, 176, 233, 192, 145, 203, 91, 174, 204, 93, 153, 203, 74, 142, 199, 76, 133, 209, 121, 120, 201, 88, 107, 202, 96, 131, 203, 79, 139, 205, 76, 196, 224, 95, 197, 219, 102, 205, 188, 60, 211, 159, 15, 209, 162, 21, 224, 202, 81, 251, 229, 108, 189, 219, 93, 159, 204, 76, 184, 228, 159, 192, 247, 255, 151, 228, 255, 81, 197, 238, 88, 198, 254, 95, 203, 249, 71, 192, 243, 70, 195, 245, 73, 194, 245, 75, 195, 244, 87, 201, 248, 93, 203, 247, 117, 215, 255, 171, 211, 171, 206, 155, 0, 191, 131, 0, 229, 211, 91, 169, 214, 98, 133, 199, 108, 159, 209, 106, 173, 231, 193, 144, 225, 255, 115, 213, 255, 124, 217, 255, 93, 204, 253, 141, 223, 255, 159, 231, 255, 93, 202, 254, 117, 211, 236, 201, 226, 148, 179, 222, 192, 190, 233, 218, 190, 226, 176, 188, 223, 153, 193, 224, 177, 180, 180, 76, 199, 214, 146, 132, 214, 114, 132, 196, 66, 212, 202, 107, 222, 191, 88, 222, 202, 82, 221, 186, 65, 219, 177, 46, 223, 185, 49, 198, 206, 93, 174, 220, 123, 170, 223, 188, 184, 236, 232, 122, 211, 235, 62, 188, 247, 79, 197, 247, 83, 199, 247, 77, 195, 245, 91, 203, 250, 73, 194, 245, 73, 194, 245, 73, 194, 245, 75, 195, 246, 85, 199, 249, 89, 203, 253, 121, 211, 245, 198, 213, 122, 211, 159, 12, 214, 208, 88, 122, 203, 92, 132, 198, 81, 164, 224, 174, 99, 207, 255, 82, 199, 252, 70, 195, 245, 80, 199, 249, 131, 217, 255, 146, 225, 255, 111, 212, 255, 93, 203, 255, 146, 222, 237, 223, 223, 122, 192, 221, 120, 185, 233, 170, 163, 230, 230, 154, 224, 211, 201, 224, 163, 196, 210, 80, 177, 174, 58, 233, 201, 72, 216, 181, 38, 189, 179, 75, 232, 238, 197, 255, 255, 255, 255, 255, 255, 234, 216, 171, 192, 185, 59, 106, 197, 93, 223, 255, 239, 200, 245, 243, 147, 220, 228, 59, 187, 240, 77, 195, 244, 85, 199, 249, 75, 195, 246, 101, 207, 255, 87, 201, 248, 105, 209, 255, 100, 205, 253, 79, 197, 247, 79, 197, 247, 97, 205, 253, 101, 205, 252, 104, 204, 255, 145, 233, 255, 197, 205, 121, 196, 183, 42, 156, 235, 250, 172, 236, 252, 179, 239, 239, 85, 199, 246, 69, 192, 240, 71, 192, 243, 111, 211, 255, 122, 213, 255, 81, 197, 247, 73, 194, 246, 129, 217, 252, 191, 224, 128, 192, 217, 76, 206, 221, 85, 239, 235, 106, 199, 224, 95, 151, 209, 73, 181, 222, 137, 240, 235, 117, 181, 220, 115, 192, 209, 114, 197, 220, 150, 137, 200, 74, 164, 207, 88, 163, 213, 135, 178, 206, 128, 210, 175, 74, 183, 205, 86, 168, 218, 120, 195, 244, 253, 121, 217, 255, 111, 210, 255, 90, 201, 248, 75, 194, 244, 77, 195, 245, 67, 190, 244, 79, 197, 245, 97, 205, 253, 100, 205, 253, 93, 202, 250, 90, 201, 245, 70, 195, 245, 77, 195, 245, 90, 201, 251, 108, 206, 254, 126, 215, 255, 145, 221, 255, 177, 184, 119, 172, 216, 165, 160, 226, 208, 167, 236, 255, 137, 222, 247, 105, 209, 255, 75, 195, 248, 121, 211, 255, 97, 205, 253, 73, 194, 245, 103, 206, 255, 139, 220, 217, 150, 205, 62, 166, 210, 81, 211, 227, 102, 222, 231, 108, 220, 227, 101, 235, 238, 112, 191, 226, 120, 221, 225, 148, 209, 218, 92, 142, 221, 177, 131, 222, 255, 187, 236, 211, 191, 220, 97, 147, 222, 207, 165, 220, 180, 170, 195, 62, 183, 230, 183, 176, 236, 255, 112, 209, 241, 67, 193, 246, 105, 209, 254, 113, 211, 255, 79, 197, 247, 87, 201, 248, 87, 201, 248, 111, 211, 255, 79, 197, 247, 87, 201, 251, 89, 203, 250, 72, 195, 246, 75, 195, 246, 93, 202, 253, 95, 203, 254, 97, 205, 253, 114, 210, 255, 134, 218, 255, 133, 222, 255, 135, 210, 234, 169, 225, 203, 161, 228, 237, 143, 208, 171, 168, 229, 206, 134, 222, 255, 101, 205, 255, 110, 208, 253, 85, 199, 246, 84, 201, 254, 127, 218, 240, 169, 216, 106, 167, 208, 72, 160, 208, 79, 184, 213, 90, 202, 221, 98, 236, 242, 126, 205, 208, 83, 213, 191, 74, 204, 235, 188, 134, 219, 255, 95, 203, 254, 153, 227, 255, 178, 228, 186, 131, 218, 255, 185, 244, 255, 182, 235, 182, 172, 232, 225, 171, 238, 255, 155, 224, 217, 73, 194, 246, 118, 213, 255, 114, 210, 252, 79, 197, 245, 93, 204, 253, 105, 209, 254, 79, 197, 247, 79, 197, 245, 72, 195, 246, 108, 209, 255, 101, 207, 255, 91, 203, 253, 95, 203, 254, 100, 205, 253, 97, 205, 253, 111, 210, 255, 135, 219, 255, 137, 216, 255, 144, 223, 255, 155, 237, 255, 167, 209, 170, 141, 186, 47, 143, 204, 75, 158, 213, 115, 161, 228, 237, 109, 211, 255, 124, 215, 255, 122, 215, 255, 105, 209, 255, 123, 211, 230, 117, 208, 193, 130, 216, 219, 203, 227, 130, 203, 223, 112, 224, 235, 126, 212, 205, 89, 195, 205, 73, 127, 212, 205, 89, 203, 255, 127, 215, 255, 139, 221, 255, 131, 219, 254, 108, 209, 254, 150, 225, 250, 207, 242, 199, 215, 253, 246, 168, 224, 168, 150, 226, 242, 125, 213, 244, 120, 215, 255, 122, 219, 255, 128, 219, 255, 119, 211, 255, 103, 207, 254, 91, 203, 250, 73, 194, 245, 87, 201, 248, 89, 203, 250, 91, 203, 253, 95, 203, 254, 100, 205, 255, 97, 205, 253, 95, 203, 254, 100, 205, 255, 132, 216, 255, 135, 219, 255, 135, 219, 255, 141, 223, 255, 164, 200, 119, 114, 192, 64, 88, 189, 82, 112, 190, 70, 140, 207, 94, 161, 220, 154, 123, 214, 236, 84, 201, 254, 108, 209, 254, 124, 215, 255, 90, 203, 255, 105, 208, 255, 170, 226, 185, 201, 223, 107, 216, 219, 116, 208, 186, 64, 148, 217, 196, 88, 203, 255, 129, 217, 255, 124, 215, 255, 139, 221, 255, 85, 201, 251, 95, 203, 252, 93, 203, 255, 135, 216, 203, 197, 239, 191, 192, 236, 185, 164, 230, 240, 184, 240, 255, 164, 215, 159, 156, 219, 203, 161, 234, 255, 157, 229, 255, 114, 210, 255, 85, 201, 249, 121, 215, 255, 103, 207, 254, 103, 207, 252, 83, 199, 249, 111, 210, 255, 113, 211, 255, 108, 209, 254, 122, 213, 255, 129, 215, 255, 135, 219, 255, 121, 213, 255, 124, 213, 255, 89, 204, 255, 158, 211, 209, 185, 209, 96, 126, 199, 76, 170, 212, 92, 187, 217, 91, 211, 227, 102, 113, 209, 229, 66, 192, 250, 111, 211, 255, 142, 221, 255, 104, 207, 251, 66, 195, 255, 145, 213, 210, 233, 204, 69, 221, 200, 83, 217, 207, 81, 163, 226, 210, 132, 219, 251, 135, 219, 255, 157, 227, 255, 116, 211, 255, 75, 195, 246, 100, 205, 255, 85, 201, 251, 82, 199, 255, 112, 209, 247, 131, 220, 255, 190, 244, 255, 188, 239, 216, 209, 247, 217, 168, 228, 218, 147, 225, 255, 144, 225, 255, 134, 220, 255, 126, 217, 255, 159, 231, 255, 79, 197, 247, 91, 203, 253, 110, 211, 255, 126, 217, 255, 130, 219, 255, 122, 213, 255, 135, 219, 255, 139, 219, 255, 132, 219, 255, 121, 213, 255, 116, 210, 255, 105, 209, 254, 102, 209, 255, 193, 225, 225, 196, 209, 101, 156, 212, 91, 235, 232, 113, 206, 231, 168, 99, 209, 255, 75, 195, 244, 108, 209, 255, 134, 218, 255, 91, 203, 250, 74, 197, 255, 171, 218, 202, 224, 192, 54, 230, 209, 86, 183, 216, 128, 173, 230, 215, 161, 215, 170, 110, 210, 255, 149, 225, 255, 118, 213, 255, 87, 201, 251, 108, 209, 255, 80, 197, 250, 69, 192, 240, 90, 204, 254, 158, 231, 239, 183, 226, 135, 174, 212, 79, 158, 213, 100, 185, 233, 175, 175, 240, 255, 145, 223, 255, 151, 227, 255, 157, 227, 255, 120, 215, 255, 67, 193, 243, 85, 201, 251, 95, 203, 254, 108, 209, 255, 110, 208, 255, 129, 215, 255, 137, 219, 255, 142, 221, 255, 142, 221, 255, 137, 219, 255, 134, 218, 255, 139, 219, 255, 107, 212, 255, 170, 210, 206, 175, 204, 91, 122, 197, 62, 221, 237, 174, 151, 227, 255, 108, 209, 255, 85, 201, 251, 110, 208, 255, 128, 217, 255, 93, 204, 253, 105, 209, 255, 142, 224, 255, 237, 216, 98, 229, 188, 36, 165, 219, 193, 136, 222, 255, 128, 213, 232, 82, 199, 255, 114, 210, 255, 137, 219, 255, 116, 211, 255, 116, 211, 255, 110, 211, 255, 98, 203, 252, 107, 211, 255, 199, 229, 124, 213, 226, 74, 204, 228, 99, 118, 197, 60, 159, 206, 58, 167, 226, 200, 164, 237, 255, 151, 227, 255, 114, 210, 255, 80, 195, 245, 79, 197, 247, 77, 197, 248, 77, 195, 245, 89, 203, 253, 97, 205, 253, 114, 210, 255, 128, 217, 255, 139, 221, 255, 144, 223, 255, 135, 216, 255, 139, 219, 255, 135, 216, 255, 110, 214, 255, 180, 206, 147, 144, 198, 53, 140, 216, 130, 149, 225, 255, 97, 205, 255, 124, 217, 255, 113, 211, 255, 132, 219, 255, 137, 218, 255, 121, 213, 255, 89, 203, 250, 92, 206, 255, 187, 229, 207, 182, 210, 168, 121, 213, 255, 107, 211, 255, 134, 219, 255, 108, 209, 254, 93, 204, 253, 108, 209, 255, 141, 221, 255, 132, 219, 255, 126, 217, 255, 103, 207, 254, 82, 199, 255, 146, 218, 190, 144, 214, 173, 145, 220, 213, 133, 209, 126, 153, 209, 77, 134, 211, 219, 143, 227, 255, 177, 242, 255, 157, 230, 255, 141, 223, 255, 101, 207, 255, 85, 201, 251, 85, 201, 251, 72, 195, 246, 79, 197, 250, 91, 203, 254, 108, 209, 255, 135, 219, 255, 142, 221, 255, 122, 213, 255, 126, 215, 255, 132, 216, 255, 134, 219, 255, 196, 211, 116, 194, 232, 157, 154, 230, 255, 59, 189, 245, 69, 192, 240, 80, 197, 250, 105, 209, 254, 142, 221, 255, 142, 221, 255, 118, 213, 255, 93, 202, 253, 93, 202, 253, 89, 204, 255, 98, 212, 255, 101, 207, 255, 141, 221, 255, 155, 227, 255, 101, 205, 255, 89, 203, 253, 116, 211, 255, 141, 221, 255, 142, 221, 255, 132, 216, 255, 111, 211, 255, 106, 207, 254, 93, 203, 255, 84, 201, 255, 77, 197, 255, 106, 209, 250, 172, 230, 220, 103, 207, 255, 95, 206, 255, 181, 236, 244, 195, 240, 237, 107, 211, 255, 75, 195, 246, 85, 199, 252, 95, 203, 254, 97, 205, 253, 97, 205, 253, 101, 207, 255, 131, 217, 255, 150, 222, 255, 142, 219, 255, 112, 208, 255, 100, 205, 253, 105, 209, 255, 145, 221, 255, 205, 227, 138, 244, 255, 255, 154, 232, 255, 91, 200, 248, 103, 209, 254, 93, 202, 250, 100, 205, 253, 116, 211, 255, 142, 223, 255, 142, 223, 255, 137, 219, 255, 126, 217, 255, 111, 211, 255, 98, 203, 249, 111, 211, 255, 142, 223, 255, 137, 219, 255, 106, 207, 254, 134, 220, 255, 190, 245, 255, 141, 221, 255, 121, 211, 255, 139, 219, 255, 147, 223, 255, 142, 219, 255, 129, 217, 255, 121, 213, 254, 124, 215, 255, 121, 215, 255, 122, 213, 255, 100, 205, 253, 110, 211, 255, 203, 248, 255, 179, 242, 255, 83, 199, 249, 93, 202, 253, 110, 211, 255, 132, 219, 255, 141, 221, 255, 139, 221, 255, 128, 217, 255, 128, 217, 255, 122, 213, 255, 110, 208, 255, 100, 205, 253, 93, 204, 253, 87, 201, 251, 100, 205, 253, 149, 222, 234, 162, 229, 255, 152, 228, 255, 146, 225, 255, 163, 231, 255, 155, 227, 255, 118, 213, 255, 106, 206, 255, 122, 213, 255, 136, 222, 255, 122, 213, 255, 100, 205, 253, 108, 209, 255, 95, 203, 252, 69, 192, 246, 93, 202, 253, 79, 197, 247, 77, 195, 248, 95, 203, 254, 142, 226, 255, 161, 234, 255, 95, 203, 254, 95, 203, 254, 106, 206, 255, 103, 207, 254, 95, 203, 254, 89, 203, 253, 97, 205, 253, 116, 211, 255, 131, 217, 255, 124, 213, 255, 124, 215, 255, 125, 220, 255, 89, 203, 250, 132, 219, 255, 139, 219, 255, 139, 219, 255, 135, 219, 255, 122, 213, 255, 104, 204, 255, 91, 203, 253, 85, 199, 255, 75, 195, 248, 73, 194, 246, 77, 197, 250, 84, 201, 254, 89, 203, 253, 98, 203, 253, 136, 221, 255, 194, 244, 255, 190, 245, 255, 139, 219, 255, 119, 211, 255, 110, 211, 255, 101, 207, 255, 87, 201, 251, 75, 195, 248, 73, 194, 246, 87, 201, 251, 89, 203, 253, 82, 199, 252, 75, 195, 248, 93, 202, 253, 93, 204, 253, 131, 219, 255, 136, 222, 255, 132, 219, 255, 134, 220, 255, 161, 231, 255, 165, 233, 255, 165, 233, 255, 175, 238, 255, 161, 231, 255, 159, 229, 255, 151, 228, 255, 159, 232, 255, 157, 230, 255, 153, 227, 255, 155, 227, 255, 144, 223, 255, 124, 215, 255, 122, 213, 255, 154, 230, 255, 121, 213, 255, 110, 211, 255, 97, 205, 253, 107, 211, 255, 121, 215, 255, 151, 227, 255, 173, 236, 255, 177, 240, 255, 175, 238, 255, 182, 242, 255, 196, 246, 255, 203, 250, 255, 214, 255, 255, 255, 255, 255, 255, 255, 255, 206, 254, 255, 162, 233, 255, 139, 221, 255, 120, 215, 255, 124, 215, 255, 149, 227, 255, 203, 248, 255, 225, 255, 255, 233, 255, 255, 248, 255, 255, 237, 255, 255, 235, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 251, 255, 255, 206, 252, 255, 172, 236, 255, 230, 255, 255, 221, 255, 255, 217, 255, 255, 233, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 253, 255, 255, 244, 255, 255, 255, 255, 255, 247, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 242, 255, 255, 239, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);

function sample(lon: number, lat: number): [number, number, number] {
  const u = ((lon + Math.PI) / (2 * Math.PI)) * TW;
  const v = ((Math.PI / 2 - lat) / Math.PI) * TH;
  const col = Math.floor(((u % TW) + TW) % TW);
  const row = Math.max(0, Math.min(TH - 1, Math.floor(v)));
  const i = (row * TW + col) * 3;
  return [TEX[i], TEX[i + 1], TEX[i + 2]];
}

interface KeptLogoAnimatedProps {
  size?: number;
  showLabel?: boolean;
  speed?: number;
  dimmed?: boolean;
  label?: string;
  compact?: boolean;
  hasMessages?: boolean;
  onNewChat?: () => void;
  onRename?: (title: string) => void;
}

export default function KeptLogoAnimated({ size = 40, showLabel = true, speed = 1, dimmed = false, label = "New Chat", compact = false, hasMessages = false, onNewChat, onRename }: KeptLogoAnimatedProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const raf = useRef<number>(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rotRef = useRef({ x: 0.15, y: 0, z: 0 });
  const velRef = useRef({ vx: 0, vy: 0.04 });
  const tRef = useRef(0);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const dimmedRef = useRef(dimmed);
  dimmedRef.current = dimmed;
  const hoveredRef = useRef(false);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const cx = cv.getContext("2d")!;
    cv.width = GW;
    cv.height = GH;

    let lastTs = 0;
    const R = GW / 2;
    const ctr = (GW - 1) / 2;
    // Smoothed brightness of the globe's front face (0–255)
    let smoothBright = 180;

    function draw() {
      const img = cx.createImageData(GW, GH);
      const px = img.data;
      const rr = rotRef.current;
      const cY = Math.cos(rr.y), sY = Math.sin(rr.y);
      const cX = Math.cos(rr.x), sX = Math.sin(rr.x);
      const cZ = Math.cos(rr.z), sZ = Math.sin(rr.z);

      let sumBright = 0, count = 0;

      for (let r = 0; r < GH; r++) {
        for (let c = 0; c < GW; c++) {
          const dx = (c - ctr) / R;
          const dy = (r - ctr) / R;
          const d2 = dx * dx + dy * dy;
          const off = (r * GW + c) * 4;

          // Clamp to sphere surface for pixels outside
          const sd2 = Math.min(d2, 1);
          let nx = dx, ny = dy, nz = Math.sqrt(Math.max(0, 1 - sd2));
          if (d2 > 1) {
            const invD = 1 / Math.sqrt(d2);
            nx = dx * invD;
            ny = dy * invD;
          }
          let tx = nx * cZ - ny * sZ, ty = nx * sZ + ny * cZ;
          nx = tx; ny = ty;
          const tz1 = ny * sX + nz * cX;
          ty = ny * cX - nz * sX;
          ny = ty; nz = tz1;
          tx = nx * cY + nz * sY;
          const tz2 = -nx * sY + nz * cY;
          nx = tx; nz = tz2;

          const lat = Math.asin(Math.max(-1, Math.min(1, -ny)));
          const lon = Math.atan2(nx, nz);
          const limb = Math.sqrt(Math.max(0, 1 - sd2));
          const shade = dimmedRef.current ? 0.35 + 0.65 * limb : 0.55 + 0.45 * limb;

          const col2 = sample(lon, lat);
          const contrast = dimmedRef.current ? 1.9 : 2.1;
          const tint = dimmedRef.current ? 0.25 : 0.35;
          const boost = (v: number) => Math.max(0, Math.min(255, ((v / 255 - 0.5) * contrast + 0.5) * 255));
          let pr = ((1 - tint) * boost(col2[0]) + tint * 60) * shade;
          let pg = ((1 - tint) * boost(col2[1]) + tint * 170) * shade;
          let pb = ((1 - tint) * boost(col2[2]) + tint * 255) * shade;
          // Boost saturation: push channels away from luminance
          const sat = dimmedRef.current ? 1.15 : 1.25;
          const lum = pr * 0.3 + pg * 0.6 + pb * 0.1;
          pr = Math.max(0, Math.min(255, lum + (pr - lum) * sat));
          pg = Math.max(0, Math.min(255, lum + (pg - lum) * sat));
          pb = Math.max(0, Math.min(255, lum + (pb - lum) * sat));
          if (dimmedRef.current) {
            const mix = 0.90; // 0 = full mono, 1 = full color
            px[off] = lum * 0.50 * (1 - mix) + pr * mix;
            px[off + 1] = lum * 0.72 * (1 - mix) + pg * mix;
            px[off + 2] = lum * 0.95 * (1 - mix) + pb * mix;
          } else {
            px[off] = pr;
            px[off + 1] = pg;
            px[off + 2] = pb;
          }
          px[off + 3] = 255;

          // Weight center pixels for average brightness
          if (d2 < 0.25) {
            const w = 1 - d2 * 4;
            sumBright += (pr * 0.3 + pg * 0.6 + pb * 0.1) * w;
            count += w;
          }
        }
      }
      cx.putImageData(img, 0, 0);

      // Very slow smoothing for gentle transitions
      if (count > 0) {
        smoothBright += ((sumBright / count) - smoothBright) * 0.015;
      }

      // Map brightness to intensity (0–1)
      const intensity = Math.max(0, Math.min(1, (smoothBright - 80) / 140));

      // Background: high-opacity light blue matching chatbox brightness
      const hov = hoveredRef.current;
      const dimBg = dimmedRef.current ? (hov ? 0.22 : 0.15) : 1;
      const dimGlow = dimmedRef.current ? 0.08 : 1;
      const bgAlpha = (0.75 + intensity * 0.20) * dimBg + (hov && !dimmedRef.current ? 0.08 : 0);
      const bgAlphaEnd = (0.65 + intensity * 0.20) * dimBg + (hov && !dimmedRef.current ? 0.06 : 0);

      if (pillRef.current) {
        const gradAngle = 135 + Math.sin(rr.y) * 30;

        pillRef.current.style.background = dimmedRef.current
          ? `linear-gradient(${gradAngle.toFixed(0)}deg, rgba(186,232,255,${bgAlpha.toFixed(3)}) 0%, rgba(200,240,255,${bgAlphaEnd.toFixed(3)}) 100%)`
          : `linear-gradient(${gradAngle.toFixed(0)}deg, rgba(120,190,240,${bgAlpha.toFixed(3)}) 0%, rgba(170,225,255,${bgAlphaEnd.toFixed(3)}) 100%)`;

      }

      // Animated inset glow: white highlight that sweeps around the pill edge
      if (pillRef.current) {
        const highlightRad = (rr.y % (Math.PI * 2));
        const glowX = Math.cos(highlightRad) * 4;
        const glowY = Math.sin(highlightRad) * 4;
        const whiteAlpha = (0.12 + intensity * 0.20) * dimGlow;
        const sx = Math.sin(rr.y) * 8;
        const sy = Math.sin(rr.x) * 4 + 4;
        const shadowAlpha = dimGlow;
        pillRef.current.style.boxShadow =
          `inset ${glowX.toFixed(1)}px ${glowY.toFixed(1)}px 8px 0 rgba(255,255,255,${whiteAlpha.toFixed(3)}), ${sx.toFixed(1)}px ${sy.toFixed(1)}px 20px 0 rgba(0,0,0,${(0.15 * shadowAlpha).toFixed(3)}), ${(sx*0.3).toFixed(1)}px ${(sy*0.3).toFixed(1)}px 8px 0 rgba(0,0,0,${(0.10 * shadowAlpha).toFixed(3)})`;
      }
    }

    function tick(ts: number) {
      if (ts - lastTs >= 16) {
        lastTs = ts;
        tRef.current += 0.012;
        const v = velRef.current;
        const rr = rotRef.current;

        v.vy += (0.035 * speedRef.current - v.vy) * 0.02;
        v.vx += (Math.sin(tRef.current * 0.19) * 0.003 - v.vx) * 0.02;
        rr.z = Math.sin(tRef.current * 0.13) * 0.15;

        v.vx *= 0.97;
        v.vy *= 0.97;
        rr.x += v.vx;
        rr.y += v.vy;
        rr.x = Math.max(-1.5, Math.min(1.5, rr.x));

        draw();
      }
      raf.current = requestAnimationFrame(tick);
    }

    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, []);

    const labelSize = Math.round(size * 0.58);
    const globeSize = size * 0.85;

  const [hovered, setHovered] = useState(false);
  hoveredRef.current = hovered;
  const expanded = hovered || menuOpen;

  // ── Animated label transition ──────────────────────────────────────────────
  const truncate = (text: string, max: number) => text.length > max ? text.slice(0, max) + "…" : text;
  const computeVisible = (text: string, exp: boolean) => exp ? truncate(text, 50) : truncate(text, 30);

  const [displayedLabel, setDisplayedLabel] = useState(computeVisible(label, false));
  const [labelOpacity, setLabelOpacity] = useState(1);
  const prevLabelRef = useRef(label);
  const prevExpandedRef = useRef(false);
  const animTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const labelChanged = label !== prevLabelRef.current;
    const expandedChanged = expanded !== prevExpandedRef.current;
    if (!labelChanged && !expandedChanged) return;
    prevLabelRef.current = label;
    prevExpandedRef.current = expanded;

    const newText = computeVisible(label, expanded);
    if (newText === displayedLabel) return;

    // Phase 1: fade out old text
    setLabelOpacity(0);
    if (animTimer.current) clearTimeout(animTimer.current);
    animTimer.current = setTimeout(() => {
      // Phase 2: swap text, fade in
      setDisplayedLabel(newText);
      requestAnimationFrame(() => setLabelOpacity(1));
    }, 200);

    return () => { if (animTimer.current) clearTimeout(animTimer.current); };
  }, [label, expanded]);

  // Close menu on click outside
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) && pillRef.current && !pillRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  // Auto-focus and select input when entering rename mode
  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  const commitRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== label) {
      onRename?.(trimmed);
    }
    setRenaming(false);
  }, [renameValue, label, onRename]);

  const cancelRename = useCallback(() => {
    setRenameValue(label);
    setRenaming(false);
  }, [label]);

  const labelStyle: React.CSSProperties = {
    fontFamily: '"DM Sans", sans-serif',
    fontWeight: 600,
    fontSize: labelSize,
    lineHeight: "100%",
    letterSpacing: "-0.00em",
    transition: "opacity 400ms cubic-bezier(0.4, 0, 0.2, 1), filter 400ms cubic-bezier(0.4, 0, 0.2, 1), color 400ms cubic-bezier(0.4, 0, 0.2, 1)",
    opacity: dimmed ? (hovered ? 0.95 : 0.8) : 1,
    filter: hovered
      ? "drop-shadow(0 1px 3px rgba(100,200,255,0.25)) brightness(1.15)"
      : "drop-shadow(0 1px 3px rgba(100,200,255,0.25))",
    fontVariationSettings: '"opsz" 30',
    whiteSpace: "nowrap",
    ...(dimmed
      ? { color: "#C8E8F8" }
      : {
          background: "linear-gradient(180deg, #0A2030 0%, #1A4A60 100%)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
        }),
  };

  const chevronSize = Math.round(size * 0.55);

  const chevronStyle: React.CSSProperties = {
    width: chevronSize,
    height: chevronSize,
    flexShrink: 0,
    opacity: dimmed ? 0.5 : 0.7,
    transition: "opacity 400ms cubic-bezier(0.4, 0, 0.2, 1), transform 300ms ease",
    transform: menuOpen ? "rotate(180deg)" : "rotate(0deg)",
  };

  // Position the portal dropdown below the pill using screen coordinates
  // Only update position on open — keep it stable during close transition
  const [menuPos, setMenuPos] = useState<{ x: number; y: number; width: number } | null>(null);

  useEffect(() => {
    if (menuOpen && pillRef.current) {
      const rect = pillRef.current.getBoundingClientRect();
      setMenuPos({ x: rect.left + rect.width / 2, y: rect.bottom + 6, width: Math.max(140, Math.min(rect.width, 220)) });
    }
  }, [menuOpen]);

  const menuFontSize = compact ? 13 : 14;
  const menuIconSize = compact ? 14 : 16;
  const menuPadV = compact ? 8 : 10;
  const menuPadH = compact ? 12 : 14;
  const menuGap = compact ? 8 : 10;
  const menuRadius = compact ? 10 : 16;
  const menuItemRadius = compact ? 7 : 10;
  const menuInnerPad = compact ? 4 : 6;

  const menuItems = [
    {
      label: "New Chat",
      icon: <svg width={menuIconSize} height={menuIconSize} viewBox="0 0 16 16" fill="none"><path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>,
      action: () => { setMenuOpen(false); onNewChat?.(); },
    },
  ];

  // Keep dropdown mounted during close transition
  const [menuVisible, setMenuVisible] = useState(false);
  useEffect(() => {
    if (menuOpen) {
      setMenuVisible(true);
    } else {
      const t = setTimeout(() => { setMenuVisible(false); setMenuPos(null); }, 400);
      return () => clearTimeout(t);
    }
  }, [menuOpen]);

  const dropdownMenu = menuVisible && menuPos && createPortal(
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        top: menuPos.y,
        left: menuPos.x,
        width: menuPos.width,
        transformOrigin: "top center",
        pointerEvents: menuOpen ? "auto" : "none",
        opacity: menuOpen ? 1 : 0,
        transform: menuOpen
          ? "translateX(-50%) translateY(0) scale(1)"
          : "translateX(-50%) translateY(-4px) scale(0.95)",
        transition: "all 400ms cubic-bezier(0.16, 1, 0.3, 1)",
        background: "linear-gradient(180deg, rgba(14, 28, 36, 0.92) 0%, rgba(8, 19, 25, 0.95) 100%)",
        backdropFilter: "blur(24px) saturate(1.4)",
        border: "1px solid rgba(195, 236, 255, 0.10)",
        borderRadius: menuRadius,
        boxShadow: "0 12px 48px rgba(0,0,0,0.45), 0 4px 16px rgba(0,0,0,0.25), inset 0 1px 0 rgba(195, 236, 255, 0.06)",
        padding: menuInnerPad,
        zIndex: 9999,
      }}
    >
      {menuItems.map((item) => (
        <button
          key={item.label}
          onClick={(e) => { e.stopPropagation(); item.action(); }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: menuGap,
            width: "100%",
            padding: `${menuPadV}px ${menuPadH}px`,
            border: "none",
            background: "transparent",
            color: "var(--color-fg-secondary)",
            fontFamily: "var(--font-sans)",
            fontSize: menuFontSize,
            fontWeight: 500,
            letterSpacing: "-0.02em",
            borderRadius: menuItemRadius,
            cursor: "pointer",
            transition: "background 200ms ease, color 200ms ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(195, 236, 255, 0.08)";
            e.currentTarget.style.color = "var(--color-fg)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--color-fg-secondary)";
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );

  return (
    <>
      <div
        ref={pillRef}
        className="flex items-center select-none"
        onMouseEnter={() => hasMessages && setHovered(true)}
        onMouseLeave={() => hasMessages && setHovered(false)}
        onClick={(e) => {
          if (renaming || !hasMessages) return;
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        style={{
          background: dimmed ? "linear-gradient(135deg, rgba(186,232,255,0.25) 0%, rgba(200,240,255,0.20) 100%)" : "linear-gradient(135deg, rgba(186,232,255,0.80) 0%, rgba(200,240,255,0.70) 100%)",
          backdropFilter: "blur(16px)",
          borderRadius: 9999,
          padding: 6,
          paddingRight: showLabel ? size * 0.45 : 6,
          gap: size * 0.2,
          border: dimmed ? "2px solid rgba(255,255,255,0.12)" : "2px solid rgba(255,255,255,0.25)",
          boxShadow: dimmed ? "0 2px 12px 0 rgba(0,0,0,0.08), 0 1px 4px 0 rgba(0,0,0,0.05)" : "0 4px 20px 0 rgba(0,0,0,0.15), 0 2px 8px 0 rgba(0,0,0,0.10)",
          cursor: hasMessages ? "pointer" : "default",
          transform: hasMessages && hovered ? "scale(1.015)" : "scale(1)",
          transition: "transform 400ms ease, background 400ms ease",
        }}
      >
        <div style={{ width: globeSize, height: globeSize, clipPath: "circle(50%)", position: "relative", flexShrink: 0, opacity: dimmed ? 0.88 : 1, transition: "opacity 600ms cubic-bezier(0.4, 0, 0.2, 1)" }}>
          <canvas ref={ref} style={{ width: "100%", height: "100%", imageRendering: "pixelated", display: "block" }} />
          <div style={{ position: "absolute", inset: 0, borderRadius: 9999, pointerEvents: "none", boxShadow: "inset 0 0 10px 3px rgba(10,60,120,0.4)" }} />
        </div>
        {showLabel && (
          <>
            {renaming ? (
              <input
                ref={inputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") cancelRename();
                }}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                style={{
                  ...labelStyle,
                  opacity: 1,
                  background: "rgba(10, 32, 48, 0.6)",
                  WebkitBackgroundClip: "unset",
                  WebkitTextFillColor: dimmed ? "#C8E8F8" : "#0A2030",
                  border: "1px solid rgba(120, 190, 240, 0.4)",
                  borderRadius: 6,
                  padding: "2px 6px",
                  outline: "none",
                  width: "auto",
                  minWidth: 60,
                  maxWidth: 200,
                }}
              />
            ) : (
              <span
                className="select-none"
                style={{
                  ...labelStyle,
                  opacity: (dimmed ? 0.8 : 1) * labelOpacity,
                  transition: "opacity 300ms cubic-bezier(0.4, 0, 0.2, 1), filter 600ms cubic-bezier(0.4, 0, 0.2, 1)",
                }}
              >
                {displayedLabel}
              </span>
            )}
            {hasMessages && (
              <svg style={chevronStyle} viewBox="0 0 18 18" fill="none">
                <path
                  d="M4.5 7L9 11.5L13.5 7"
                  stroke={dimmed ? "#C8E8F8" : "#0A2030"}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </>
        )}
      </div>
      {dropdownMenu}
    </>
  );
}
